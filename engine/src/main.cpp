// Prusaslicer - Web Boss: the engine.
//
// Holds one project (models + presets + sliced state) and slices it with BOSS 3.0's own
// service layer, the way BOSS's command-line slicer drives it: a Workbench and a
// ProjectInteractor (presets, scene, slicing, arrange, export), whose background work
// reports back through a main-thread dispatcher this program pumps. BOSS keeps one slicing
// process per bed and re-slices only what a change affects (Print::apply). Talks JSON
// lines: one command per line on stdin, one event per line on stdout. Everything else
// (BOSS's own logging) goes to stderr.
//
// Commands (an optional "id" is echoed back on the reply):
//   {"cmd":"hello"}
//   {"cmd":"catalog"}                                     every FFF printer of every bundled vendor
//   {"cmd":"select_presets","vendor":"PrusaResearch","printer":"...","print":"...","filament":"..."}
//                                                         print and filament are optional
//   {"cmd":"schema"}                                      pages, groups and definitions of the settings tabs
//   {"cmd":"settings"}                                    values and change marks of the settings tabs
//   {"cmd":"set","preset":"print","config":{"fill_density":"20%","temperature":{"index":0,"value":"215"}}}
//                                                         edit settings (a text, a list, or one tool's / slot's value)
//   {"cmd":"reset","preset":"print","keys":["fill_density"]}  back to the presets' values (all, without keys)
//   {"cmd":"save_preset","preset":"print","name":"My PLA"} save as a user preset, which becomes selected
//   {"cmd":"load","path":"/data/model.stl"}               add the objects in a model file
//   {"cmd":"add_shape","shape":"cube"|"sphere","size":20} add a test shape (mm)
//   {"cmd":"transform","object":3,"instance":0,"matrix":[16 numbers, column-major]}
//   {"cmd":"object_config","object":3,"set":{"fill_density":"40%"},"remove":["perimeters"]}
//                                                         one object's own settings
//   {"cmd":"add_volume","object":3,"type":"modifier","shape":"box"}
//                                                         type: part, negative, modifier, support_enforcer,
//                                                         support_blocker; shape: box, cylinder, sphere
//   {"cmd":"volume_transform","object":3,"volume":5,"matrix":[16 numbers, in the object's coordinates]}
//   {"cmd":"volume_config","object":3,"volume":5,"set":{...},"remove":[...]}
//   {"cmd":"delete_volume","object":3,"volume":5}
//   {"cmd":"delete","object":3}  {"cmd":"clear"}  {"cmd":"arrange"}  {"cmd":"state"}
//   {"cmd":"slice"}                                       slice the bed, write G-code + preview
//   {"cmd":"quit"}
//
// "state" replies with the whole plate. Every other reply (an error too) carries what BOSS
// changed, as its listeners report it (ChangeTracker), when anything did:
//   "changes": {"objects": [changed objects, whole], "order": [every object's id, in order],
//               "stale": the slicing input changed, "plate": {presets, sidebar settings, bed,
//               thumbnails, choices}, "settings": {settings tabs}}   (the last two when presets
//                                                                     or settings changed)
//
// Files go to the current directory: mesh-<volume>.bin (geometry for the browser),
// preview.bin (toolpaths for the browser) and output.gcode or output.bgcode. G-code
// thumbnails are read from thumb-<w>x<h>.rgba, which the browser draws (BrowserThumbnails).

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <functional>
#include <future>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include <unistd.h>

#include <boost/filesystem.hpp>
#include <nlohmann/json.hpp>

#include "Slic3r/App/AppConfig.hpp"
#include "Slic3r/App/AppServices.hpp"
#include "Slic3r/App/CLI/CLIRuntime.hpp"
#include "Slic3r/App/CLI/CLIUtils.hpp"
#include "Slic3r/App/DisplayStrings.hpp"
#include "Slic3r/App/IDialogManager.hpp"
#include "Slic3r/App/Init.hpp"
#include "Slic3r/App/Platform/StdMainThreadDispatcher.hpp"
#include "Slic3r/Biz/Algorithms/Scaling.hpp"
#include "Slic3r/Biz/Algorithms/TriangleMesh.hpp"
#include "Slic3r/Biz/AppInstance/AppInstanceMessageHandlerFactory.hpp"
#include "Slic3r/Biz/Arrange/Settings.hpp"
#include "Slic3r/Biz/ArrangeInteractor.hpp"
#include "Slic3r/Biz/FDMResultCache.hpp"
#include "Slic3r/Biz/StatusCache.hpp"
#include "Slic3r/Biz/Config/ConfigSerialize.hpp"
#include "Slic3r/Biz/FileLoadingLogic.hpp"
#include "Slic3r/Biz/Platform/JobManager/JobManager.hpp"
#include "Slic3r/Biz/Platform/PlatformServices.hpp"
#include "Slic3r/Biz/Preset/IO/BundlePaths.hpp"
#include "Slic3r/Biz/Preset/IPresetDialogManager.hpp"
#include "Slic3r/Biz/Preset/NameValidator.hpp"
#include "Slic3r/Biz/Preset/PresetInteractor.hpp"
#include "Slic3r/Biz/ProjectInteractor.hpp"
#include "Slic3r/Biz/ResultExport/ExportNameParser.hpp"
#include "Slic3r/Biz/Scene/SceneInteractor.hpp"
#include "Slic3r/Biz/Scene/Selection.hpp"
#include "Slic3r/Biz/SecretStoreDummy.hpp"
#include "Slic3r/Biz/Slicing/SlicingInteractor.hpp"
#include "Slic3r/Directories.hpp"
#include "Slic3r/Domain/BedInstance.hpp"
#include "Slic3r/Domain/ConfigPack.hpp"
#include "Slic3r/Domain/Image.hpp"
#include "Slic3r/Domain/Model.hpp"
#include "Slic3r/Domain/ModelInstance.hpp"
#include "Slic3r/Domain/ModelObject.hpp"
#include "Slic3r/Domain/ModelVolume.hpp"
#include "Slic3r/Domain/Preset/Bundle.hpp"
#include "Slic3r/Domain/PrintStatistics.hpp"
#include "Slic3r/Domain/Project.hpp"
#include "Slic3r/Domain/Workbench.hpp"
#include "Slic3r/Version.hpp"

#include "settings.hpp"

using json = nlohmann::json;
using namespace Slic3r;
namespace fs = boost::filesystem;

using Biz::ProjectInteractor;
using Biz::Preset::PresetInteractor;
using Domain::ConfigPackFDM;
using Domain::ElementRef;
using Domain::ModelObject;
using Domain::ModelVolume;
using Domain::ModelVolumeType;

namespace {

std::mutex out_mutex;
// The real stdout, for events only; see main()
FILE* events_out = stdout;

void emit(const json& event)
{
    std::lock_guard<std::mutex> lock(out_mutex);
    const std::string line = event.dump() + "\n";
    std::fwrite(line.data(), 1, line.size(), events_out);
    std::fflush(events_out);
}

// ---- running BOSS's service layer headless ----

// BOSS asks its dialog manager for answers while loading files; nobody is there to answer
class HeadlessDialogManager : public App::IDialogManager {
public:
    void show_file_dialog(App::FileDialogType, const std::string&, const fs::path&, const std::string&,
                          const std::string&, const FileCallback&) override {}
    std::string show_input_dialog(const std::string&, const std::string&, const std::string&) override { return {}; }
    void show_input_dialog_with_buttons(const std::string&, const std::string&, const std::string&,
                                        const std::vector<ButtonWithCallback>&) override {}
    std::string show_combo_dialog(const std::string&, const std::string&, const std::vector<std::string>&) override { return {}; }
    void show_webview_dialog(std::unique_ptr<App::Browser::AbstractBrowserLogic>&&, ProjectInteractor*) override {}
    void show_upload_webview_dialog(std::unique_ptr<App::Browser::AbstractUploadBrowserLogic>&&, ProjectInteractor*,
                                    const UploadCallback&) override {}
    void show_yesno_dialog(const std::string&, const std::string&, const YesNoCallback&) override {}
    void show_rich_yesno_dialog(const std::string&, const std::string&, const std::string&, const YesNoCallback&,
                                const CheckBoxCheckedCallback&) override {}
    void show_yesnocancel_dialog(const std::string&, const std::string&, const Button&, const Button&, const Button&) override {}
    void show_diff_dialog(const PresetInteractor&, std::optional<Domain::Preset::PresetKind>) override {}
    std::string show_ramming_dialog(const std::string& ramming_parameters) override { return ramming_parameters; }
    std::optional<App::WipingDialogResult> show_wiping_dialog(const std::vector<double>&, const std::vector<Domain::ColorRGB>&,
                                                         double, const std::vector<double>&, bool) override { return std::nullopt; }
    void open_in_browser(const std::string&, int) override {}
    void show_info_dialog(const std::string& text, const std::string& title, bool) override { warn(title, text); }
    void show_warning_dialog(const std::string& text, const std::string& title) override { warn(title, text); }
    void show_error_dialog(const std::string& text, const std::string& title) override { warn(title, text); }
    PresetsSwitchStates show_unsaved_changes_dialog(const std::string&, const Domain::ConfigPack&, const Domain::ConfigPack&,
                                                    Domain::ConfigPack*, const Biz::Preset::PresetSelectionNames&,
                                                    const Biz::Preset::PresetSelectionNames&, const PresetInteractor&,
                                                    bool) override { return {}; }
    std::optional<Biz::StepLoadDialogResult> show_load_step_dialog(const std::string&, double, double, bool) override { return std::nullopt; }
    std::string show_save_dialog(Domain::Preset::PresetKind, const std::string&, const PresetInteractor&) override { return {}; }
    NamesPerKindMap show_save_print_tool_dialog(const NamesPerKindMap&, const PresetInteractor&) override { return {}; }

private:
    static void warn(const std::string& title, const std::string& text)
    {
        emit({ { "event", "warning" }, { "message", title.empty() ? text : title + ": " + text } });
    }
};

// BOSS asks its preset dialog manager for the name to save a preset under; the engine answers
// with the name the page sent. Several tools' print settings are saved next to the print
// preset, one preset per tool, as BOSS's save dialog names them by default.
class PresetNamer final : public Biz::Preset::IPresetDialogManager {
public:
    explicit PresetNamer(std::string name) : m_name(std::move(name)) {}

    PresetsSwitchStates show_unsaved_changes_dialog(const std::string&, const Domain::ConfigPack&, const Domain::ConfigPack&,
                                                    Domain::ConfigPack*, const Biz::Preset::PresetSelectionNames&,
                                                    const Biz::Preset::PresetSelectionNames&, const PresetInteractor&,
                                                    bool) override { return {}; }
    std::string show_save_dialog(Domain::Preset::PresetKind, const std::string&, const PresetInteractor&) override { return m_name; }
    NamesPerKindMap show_save_print_tool_dialog(const NamesPerKindMap& original, const PresetInteractor&) override
    {
        using Domain::Preset::PresetKind;
        NamesPerKindMap names = { { PresetKind::FdmPrint, { m_name } }, { PresetKind::FdmToolPrint, {} } };
        const auto it = original.find(PresetKind::FdmToolPrint);
        const size_t tools = it == original.end() ? 0 : it->second.size();
        for (size_t i = 0; i < tools; ++i)
            names[PresetKind::FdmToolPrint].push_back(m_name + " - Tool " + std::to_string(i + 1));
        return names;
    }

private:
    std::string m_name;
};

// G-code thumbnails. BOSS draws them with OpenGL in its window; the engine has none, so the
// browser draws the plate at each size the printer wants and uploads the pixels as
// thumb-<w>x<h>.rgba before slicing: RGBA, bottom row first (as WebGL reads them). BOSS 3.0
// wants top row first. A size the browser didn't draw is left out, which BOSS accepts.
// Called from the slicing worker; it only reads files.
class BrowserThumbnails final : public Biz::Slicing::IThumbnailImageGenerator {
public:
    std::future<Biz::Slicing::ThumbnailImageResults> enqueue_thumbnail_requests(
        const Biz::Slicing::ThumbnailImageRequests& requests) override
    {
        std::promise<Biz::Slicing::ThumbnailImageResults> promise;
        Biz::Slicing::ThumbnailImageResults results;
        for (const auto& request : requests) {
            Biz::Slicing::ThumbnailImageResult result;
            result.type            = request.type;
            result.project_id      = request.params.project_id;
            result.bed_instance_id = request.params.bed_instance_id;
            bool complete = true;
            for (const Domain::Size& size : request.params.sizes) {
                std::optional<Domain::Image> image = read(size.width, size.height);
                if (!image) {
                    complete = false;
                    break;
                }
                result.images.push_back(std::move(*image));
            }
            if (complete && !result.images.empty())
                results.push_back(std::move(result));
        }
        promise.set_value(std::move(results));
        return promise.get_future();
    }

    void handle_enqueued_requests() override {}

private:
    static std::optional<Domain::Image> read(int w, int h)
    {
        if (w <= 0 || h <= 0)
            return std::nullopt;
        std::ifstream f("thumb-" + std::to_string(w) + "x" + std::to_string(h) + ".rgba", std::ios::binary);
        const size_t row = size_t(w) * 4;
        Domain::Image::Data bottom_up(row * size_t(h));
        if (!f || !f.read(reinterpret_cast<char*>(bottom_up.data()), std::streamsize(bottom_up.size())))
            return std::nullopt;
        Domain::Image::Data top_down(bottom_up.size());
        for (int y = 0; y < h; ++y)
            std::copy_n(bottom_up.data() + size_t(h - 1 - y) * row, row, top_down.data() + size_t(y) * row);
        return Domain::Image(Domain::PixelFormat::RGBA8, w, h, std::move(top_down));
    }
};

// BOSS's platform services and project interactor, set up as BOSS's CLIRuntime does it, with
// the browser's thumbnails
class Runtime {
public:
    Runtime()
    {
        auto& ps = Biz::Platform::PlatformServices::instance();
        ps.set_secret_store(std::make_unique<Biz::SecretStoreDummy>());
        ps.set_job_manager(nullptr);
        ps.set_app_instance_message_handler(nullptr);
        ps.set_main_thread_dispatcher(std::make_unique<App::Platform::StdMainThreadDispatcher>());
        ps.set_job_manager(std::make_unique<Biz::Platform::JobManager::JobManager>(ps.main_thread_dispatcher()));
        ps.set_app_instance_message_handler(Biz::AppInstance::create_app_instance_message_handler(ps.main_thread_dispatcher()));
        m_interactor.emplace(m_workbench, ps.main_thread_dispatcher(), m_thumbnails);
        // Object settings and the object menu take undo snapshots; the page has no undo yet,
        // so BOSS's no-op provider takes them, as in BOSS's own tests
        m_interactor->set_undo_provider(std::make_unique<Biz::NoopUndoProvider>());
    }

    ~Runtime()
    {
        dispatcher().close();
        m_interactor.reset();
    }

    ProjectInteractor& pi() { return *m_interactor; }
    const ProjectInteractor& pi() const { return *m_interactor; }
    Biz::Platform::IMainThreadDispatcher& dispatcher() { return Biz::Platform::PlatformServices::instance().main_thread_dispatcher(); }

    // Runs BOSS's queued main-thread work until the predicate holds; `tick` runs each round
    void wait_until(const std::function<bool()>& done, const std::function<void()>& tick = {})
    {
        while (true) {
            dispatcher().dispatch_enqueued();
            if (done()) {
                while (dispatcher().dispatch_enqueued()) {}
                return;
            }
            if (tick)
                tick();
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
    }

private:
    BrowserThumbnails m_thumbnails;
    Domain::Workbench m_workbench;
    std::optional<ProjectInteractor> m_interactor;
};

// ---- what changed ----

// What BOSS changed while the engine ran a command, as BOSS's own listeners report it (the
// desktop app redraws from the same events): which objects' placement, parts or settings
// changed or went away, whether the selected presets or their values changed, and whether
// the slicing input changed, i.e. the last slice no longer matches the plate
class ChangeTracker final : public Biz::Scene::ISceneChangedListener,
                            public Biz::Preset::IPresetChangedListener,
                            public Biz::ISlicingInputChangedListener {
public:
    std::set<size_t> objects;
    // Every object: the model was reloaded
    bool all_objects = false;
    // The selected presets changed: names, offered presets, bed
    bool presets = false;
    // A setting's value changed (or every value, with the presets)
    bool values = false;
    // An object's or volume's own settings changed: they belong to what BOSS's scene has selected
    bool selected_object_settings = false;
    bool slicing_input = false;

    bool empty() const
    {
        return objects.empty() && !all_objects && !presets && !values && !selected_object_settings && !slicing_input;
    }
    void clear()
    {
        objects.clear();
        all_objects = presets = values = selected_object_settings = slicing_input = false;
    }

    // BOSS's scene
    void on_instance_added(Domain::SelectionId, const Domain::ElementRefs& e) override { touch(e); }
    void on_instance_removed(Domain::SelectionId, const Domain::ElementRefs& e) override { touch(e); }
    void on_instance_transformed(Domain::SelectionId, const Domain::ElementRefs& e, Biz::Scene::TransformState,
                                 const Biz::BedTrackingChanges&) override { touch(e); }
    void on_volume_added(Domain::SelectionId, const Domain::ElementRefs& e, const Biz::BedTrackingChanges&) override { touch(e); }
    void on_volume_removed(Domain::SelectionId, const Domain::ElementRefs& e, const Biz::BedTrackingChanges&) override { touch(e); }
    void on_volume_transformed(Domain::SelectionId, const Domain::ElementRefs& e, Biz::Scene::TransformState,
                               const Biz::BedTrackingChanges&) override { touch(e); }
    void on_volume_type_changed(Domain::SelectionId, const Domain::ElementRefs& e, const Biz::BedTrackingChanges&) override { touch(e); }
    void on_volume_reordered(Domain::SelectionId, const Domain::ElementRefs& e) override { touch(e); }
    void on_volume_mesh_changed(Domain::SelectionId, const Domain::ElementRefs& e) override { touch(e); }
    void on_element_renamed(Domain::SelectionId, const Domain::ElementRef& e) override { touch({ e }); }
    void on_model_reloaded(Domain::SelectionId) override { all_objects = true; }

    // BOSS's presets
    void on_preset_selection_changed(Domain::SelectionId, Domain::SelectionId, Biz::Preset::PresetItemType) override
    {
        presets = values = true;
    }
    void on_preset_bundles_reloaded() override { presets = values = true; }
    void on_preset_bundles_initialized() override { presets = values = true; }
    void on_preset_value_changed(Domain::SelectionId, Domain::SelectionId, const Domain::ConfigItem& item) override
    {
        value_changed(item);
    }
    void on_preset_discarded_changes(Domain::SelectionId, Domain::SelectionId, Biz::Preset::PresetItemType) override
    {
        values = true;
    }
    void on_preset_item_discarded_changes(Domain::SelectionId, Domain::SelectionId, const Domain::ConfigItem& item) override
    {
        value_changed(item);
    }

    void on_slicing_input_changed(const Domain::BedRef&) override { slicing_input = true; }
    void on_slicing_input_removed(const Domain::BedRef&) override { slicing_input = true; }

private:
    void touch(const Domain::ElementRefs& elements)
    {
        for (const Domain::ElementRef& e : elements)
            if (!e.is_wipe_tower())
                objects.insert(e.object_id);
    }

    void value_changed(const Domain::ConfigItem& item)
    {
        const Domain::ConfigLocation location = item.location();
        const auto* loc = std::get_if<Domain::FDMConfigLocation>(&location);
        if (loc && (*loc == Domain::FDMConfigLocation::Object || *loc == Domain::FDMConfigLocation::Volume))
            selected_object_settings = true;
        else
            values = true;
    }
};

// ---- the project ----

// Settings the plater sidebar shows next to the presets, sent with every state
const char* const SIDEBAR_SETTINGS[] = {
    "support_material", "support_material_auto", "support_material_buildplate_only",
    "fill_density", "brim_width",
};

const char* volume_type_name(ModelVolumeType type)
{
    switch (type) {
    case ModelVolumeType::NEGATIVE_VOLUME:    return "negative";
    case ModelVolumeType::PARAMETER_MODIFIER: return "modifier";
    case ModelVolumeType::SUPPORT_BLOCKER:    return "support_blocker";
    case ModelVolumeType::SUPPORT_ENFORCER:   return "support_enforcer";
    default:                                  return "part";
    }
}

std::vector<double> matrix_values(const Domain::Transform3d& t)
{
    return std::vector<double>(t.matrix().data(), t.matrix().data() + 16);
}

// A transformation from the browser: 16 numbers, column-major (as Eigen and three.js)
Domain::SquareMatrix4d matrix_of(const json& matrix)
{
    if (!matrix.is_array() || matrix.size() != 16)
        throw std::runtime_error("matrix must be 16 numbers");
    Domain::SquareMatrix4d m;
    for (int i = 0; i < 16; ++i)
        m.data()[i] = matrix[i].get<double>();
    if (std::abs(m.block<3, 3>(0, 0).determinant()) < 1e-9)
        throw std::runtime_error("matrix is degenerate");
    return m;
}

std::string format_time(float seconds)
{
    long s = std::lround(seconds);
    const long d = s / 86400, h = s % 86400 / 3600, m = s % 3600 / 60;
    s %= 60;
    std::string out;
    if (d) out += std::to_string(d) + "d ";
    if (d || h) out += std::to_string(h) + "h ";
    if (d || h || m) out += std::to_string(m) + "m ";
    return out + std::to_string(s) + "s";
}

class Project {
public:
    explicit Project(Runtime& runtime) : m_rt(runtime)
    {
        m_rt.pi().new_project();
        Biz::Scene::SceneInteractor& scene = m_rt.pi().scene_interactor();
        PresetInteractor& presets = m_rt.pi().preset_interactor();
        scene.add_listener<Biz::Scene::ISceneChangedListener>(&m_changes);
        scene.add_listener<Biz::ISlicingInputChangedListener>(&m_changes);
        presets.add_listener<Biz::Preset::IPresetChangedListener>(&m_changes);
        presets.add_listener<Biz::ISlicingInputChangedListener>(&m_changes);
    }

    ~Project()
    {
        Biz::Scene::SceneInteractor& scene = m_rt.pi().scene_interactor();
        PresetInteractor& presets = m_rt.pi().preset_interactor();
        scene.remove_listener<Biz::Scene::ISceneChangedListener>(&m_changes);
        scene.remove_listener<Biz::ISlicingInputChangedListener>(&m_changes);
        presets.remove_listener<Biz::Preset::IPresetChangedListener>(&m_changes);
        presets.remove_listener<Biz::ISlicingInputChangedListener>(&m_changes);
    }

    // What changed since the last call, for every tab showing the project to apply (null when
    // nothing did): the changed objects, whole; every object's id, in order (an object missing
    // from it is gone); the plate's own fields and the settings tabs when the presets or a
    // setting changed; and whether the slice no longer matches the plate
    json take_changes()
    {
        ChangeTracker& c = m_changes;
        if (c.empty())
            return nullptr;
        if (c.selected_object_settings)
            for (const ElementRef& e : m_rt.pi().scene_interactor().object_selection().elements)
                if (!e.is_wipe_tower())
                    c.objects.insert(e.object_id);
        json objects = json::array(), order = json::array();
        for (const ModelObject* o : project().model().objects) {
            order.push_back(o->id().id);
            if (c.all_objects || c.objects.count(o->id().id))
                objects.push_back(object_json(*o));
        }
        json out = { { "objects", objects }, { "order", order }, { "stale", c.slicing_input } };
        if (c.presets || c.values) {
            out["plate"] = plate_fields(c.presets);
            out["settings"] = settings();
        }
        c.clear();
        return out;
    }

    // Forgets what changed: the page is about to get the whole state
    void drop_changes() { m_changes.clear(); }

    // Every FFF printer BOSS knows, grouped vendor > model
    json catalog() const
    {
        const PresetInteractor& presets = m_rt.pi().preset_interactor();
        const auto& vendors = m_rt.pi().workbench().preset_bundle().vendor_bundles;
        std::map<std::string, std::map<std::string, json>> grouped; // vendor > model > printers
        for (const auto [ref, runtime] : presets.get_printer_configs(m_rt.pi().selected_project_id())) {
            const Domain::Preset::HwPrinterConfig& hw = ref.get();
            if (hw.technology != Domain::PrinterTechnology::FFF)
                continue;
            json& printers = grouped[hw.vendor_id][hw.model.model];
            if (printers.is_null())
                printers = json::array();
            printers.push_back({ { "name", hw.name }, { "variant", hw.short_name } });
        }
        json out = json::array();
        for (const auto& [vendor_id, models] : grouped) {
            const auto it = vendors.find(vendor_id);
            json models_json = json::array();
            for (const auto& [model, printers] : models)
                models_json.push_back({ { "id", model }, { "name", model }, { "family", "" }, { "printers", printers } });
            out.push_back({ { "id", vendor_id },
                            { "name", it != vendors.end() ? it->second.vendor_data.info.name : vendor_id },
                            { "models", models_json } });
        }
        return out;
    }

    // Printer presets users saved, for the printer picker: [{"vendor", "name"}]
    json user_printers() const
    {
        const PresetInteractor& presets = m_rt.pi().preset_interactor();
        json out = json::array();
        for (const auto [ref, runtime] : presets.get_printer_configs(m_rt.pi().selected_project_id())) {
            const Domain::Preset::HwPrinterConfig& hw = ref.get();
            if (hw.technology != Domain::PrinterTechnology::FFF)
                continue;
            for (const auto [p, rt] : presets.get_printer_presets(hw.id))
                if (p.get().origin == Domain::Preset::PresetOrigin::User)
                    out.push_back({ { "vendor", hw.vendor_id }, { "name", p.get().name } });
        }
        return out;
    }

    // Picks the printer, then a print and a filament for it: the requested ones when they
    // fit, else the current ones, else the first offered
    json select_presets(const std::string& vendor, const std::string& printer_name,
                        const std::string& print_name, const std::string& filament_name, bool transfer = false)
    {
        PresetInteractor& presets = m_rt.pi().preset_interactor();
        // Settings changed from the presets selected now, in case they're carried over
        std::vector<std::pair<std::string, json>> edits;
        if (transfer && !m_saved_values.is_null()) {
            const json now = web::tab_values(m_rt.pi());
            for (const auto& [tab, keys] : web::modified_keys(now, m_saved_values))
                for (const std::string& k : keys) {
                    const size_t hash = k.find('#');
                    const std::string key = k.substr(0, hash);
                    const json& v = now[tab][key];
                    edits.emplace_back(key, hash == std::string::npos ? v
                                                : json{ { "index", std::stoul(k.substr(hash + 1)) },
                                                        { "value", v[std::stoul(k.substr(hash + 1))] } });
                }
        }
        // A printer by its name, or a printer preset a user saved for one
        using Domain::Preset::PresetOrigin;
        std::string hw_id, vendor_id, printer_id;
        bool user_printer = false;
        for (const auto [ref, runtime] : presets.get_printer_configs(m_rt.pi().selected_project_id())) {
            const Domain::Preset::HwPrinterConfig& h = ref.get();
            if (h.technology != Domain::PrinterTechnology::FFF || (!vendor.empty() && h.vendor_id != vendor))
                continue;
            if (h.name == printer_name) {
                hw_id = h.id;
                vendor_id = h.vendor_id;
                break;
            }
            for (const auto [p, rt] : presets.get_printer_presets(h.id))
                if (p.get().origin == PresetOrigin::User && p.get().name == printer_name) {
                    hw_id = h.id;
                    vendor_id = h.vendor_id;
                    printer_id = p.get().id;
                    user_printer = true;
                    break;
                }
            if (!hw_id.empty())
                break;
        }
        if (hw_id.empty())
            throw std::runtime_error("unknown printer: " + printer_name);

        // For a printer by name, its system printer preset
        for (const auto [ref, runtime] : presets.get_printer_presets(hw_id))
            if (printer_id.empty() || (!user_printer && ref.get().origin == PresetOrigin::System)) {
                printer_id = ref.get().id;
                if (ref.get().origin == PresetOrigin::System)
                    break;
            }
        if (printer_id.empty())
            throw std::runtime_error("no printer preset for " + printer_name);
        presets.select_printer_preset(hw_id, printer_id);
        settle();
        // What BOSS picked for this printer, used when nothing else was asked for
        const Domain::Preset::SelectedPreset& chosen = m_rt.pi().selected_config_container().selected_preset();
        const std::string boss_print = chosen.print.name;
        const std::string boss_material = chosen.materials.empty() ? std::string() : chosen.materials.front().name;

        std::vector<std::string> user_names; // the user's own presets among those offered
        std::vector<std::pair<std::string, std::string>> prints; // name, id
        for (const auto [ref, runtime] : presets.get_print_presets(hw_id, printer_id)) {
            prints.emplace_back(ref.get().name, ref.get().id);
            if (ref.get().origin == PresetOrigin::User)
                user_names.push_back(ref.get().name);
        }
        if (prints.empty())
            throw std::runtime_error("no print profile fits " + printer_name);
        const auto print = pick(prints, { print_name, m_print_name, boss_print });
        presets.select_print_preset(print.second);
        settle();

        std::vector<std::pair<std::string, std::string>> materials;
        for (const auto [ref, runtime] : presets.get_material_presets(hw_id, printer_id, print.second, 0)) {
            materials.emplace_back(ref.get().name, ref.get().id);
            if (ref.get().origin == PresetOrigin::User)
                user_names.push_back(ref.get().name);
        }
        if (materials.empty())
            throw std::runtime_error("no filament profile fits " + printer_name);
        const auto material = pick(materials, { filament_name, m_filament_name, boss_material });
        // Every material slot gets the filament, as BOSS's CLI does with one filament named
        const size_t slots = std::max<size_t>(1, presets.current_printer_config().material_slot_count());
        for (size_t slot = 0; slot < slots; ++slot)
            presets.select_material_preset(slot, material.second);
        settle();
        // The presets' own values, which change marks are against; then the carried-over edits
        m_saved_values = web::tab_values(m_rt.pi());
        for (const auto& [key, value] : edits) {
            try {
                web::set_setting(m_rt.pi(), key, value);
            } catch (const std::exception&) {
                // not a setting of the new preset; dropped, as BOSS's transfer does
            }
        }
        settle();

        m_vendor        = vendor_id;
        m_printer_name  = printer_name;
        m_print_name    = print.first;
        m_filament_name = material.first;
        m_user_printer  = user_printer;
        m_user_names    = user_names;
        m_print_choices.clear();
        for (const auto& p : prints)
            m_print_choices.push_back(p.first);
        m_filament_choices.clear();
        for (const auto& m : materials)
            m_filament_choices.push_back(m.first);
        // The names, offered presets and the values change marks go by are the engine's own,
        // so they're sent even when BOSS kept the same presets
        m_changes.presets = m_changes.values = true;
        return json::object();
    }

    // Edits settings of the selected presets: a value, a whole list, or one tool's / slot's
    // value ({"index", "value"}). `tab` only checks the setting is where the page says.
    json set(const json& values, const std::string& tab)
    {
        json changed = json::array();
        for (auto& [key, value] : values.items()) {
            if (!tab.empty() && web::tab_of(key) != tab && !web::tab_of(key).empty())
                throw std::runtime_error(key + " isn't a " + tab + " setting");
            if (web::set_setting(m_rt.pi(), key, value))
                changed.push_back(key);
            settle();
        }
        return { { "changed", changed } };
    }

    // Back to the presets' values: some settings ("key" or "key#i"), or all of a tab's
    json reset(const std::string& tab, const std::vector<std::string>& keys)
    {
        if (m_saved_values.is_null())
            throw std::runtime_error("choose a printer first");
        const json now = web::tab_values(m_rt.pi());
        std::vector<std::string> todo = keys;
        if (todo.empty())
            todo = web::modified_keys(now, m_saved_values)[tab];
        for (const std::string& k : todo) {
            const size_t hash = k.find('#');
            const std::string key = k.substr(0, hash);
            const std::string key_tab = web::tab_of(key);
            if (!m_saved_values.contains(key_tab) || !m_saved_values[key_tab].contains(key))
                continue;
            const json& saved = m_saved_values[key_tab][key];
            if (hash == std::string::npos) {
                if (web::is_per_slot(key) && saved.is_array()) {
                    // Every tool's / slot's value
                    for (size_t i = 0; i < saved.size(); ++i)
                        web::set_setting(m_rt.pi(), key, { { "index", i }, { "value", saved[i] } });
                } else
                    web::set_setting(m_rt.pi(), key, saved);
            } else {
                const size_t i = std::stoul(k.substr(hash + 1));
                if (saved.is_array() && i < saved.size())
                    web::set_setting(m_rt.pi(), key, { { "index", i }, { "value", saved[i] } });
            }
            settle();
        }
        return json::object();
    }

    // Everything the settings tabs show: each tab's values, which differ from the presets
    // ("key" or "key#slot"), and which are greyed out (none yet on 3.0)
    json settings() const
    {
        if (m_saved_values.is_null())
            return nullptr;
        const json now = web::tab_values(m_rt.pi());
        json modified = json::object();
        for (const auto& [tab, keys] : web::modified_keys(now, m_saved_values))
            modified[tab] = keys;
        return { { "values", now }, { "modified", modified }, { "disabled", json::array() } };
    }

    // Saves a preset's current values as a user preset, as BOSS's "Save preset" does, with
    // BOSS's own name checks. The saved preset becomes the selected one. BOSS 3.0 has no way
    // to delete a user preset, so neither does the page.
    json save_preset(const std::string& type, const std::string& raw_name)
    {
        using Domain::Preset::PresetKind;
        if (m_vendor.empty())
            throw std::runtime_error("choose a printer first");
        const PresetKind kind = type == "print"      ? PresetKind::FdmPrint
                                : type == "filament" ? PresetKind::FdmMaterial
                                : type == "printer"  ? PresetKind::FdmPrinter
                                                     : throw std::runtime_error("unknown preset type: " + type);
        std::string name = raw_name;
        name.erase(0, name.find_first_not_of(" \t"));
        name.erase(name.find_last_not_of(" \t") + 1);
        if (name.empty())
            throw std::runtime_error("enter a name for the preset");
        PresetInteractor& presets = m_rt.pi().preset_interactor();
        const std::string current = type == "print" ? m_print_name : type == "filament" ? m_filament_name : m_printer_name;
        const auto check = Biz::Preset::NameValidator(presets, kind, current, false).validate(name);
        if (check.type == Biz::Preset::NameValidator::ValidationType::Invalid)
            throw std::runtime_error(check.message.empty() ? "choose another name" : check.message);

        PresetNamer namer(name);
        presets.set_dialog_manager(&namer);
        try {
            if (kind == PresetKind::FdmPrint)
                presets.save_user_tool_print_presets();
            else
                presets.save_user_preset(kind, 0);
            settle();
        } catch (...) {
            presets.set_dialog_manager(nullptr);
            throw;
        }
        presets.set_dialog_manager(nullptr);

        // Selected again by name, which refreshes the offered presets (they now include the
        // new one) and carries over the other tabs' unsaved edits
        return select_presets(m_vendor, type == "printer" ? name : m_printer_name, type == "print" ? name : m_print_name,
                              type == "filament" ? name : m_filament_name, true);
    }

    // An object's own settings, overriding the presets for that object only (BOSS's object
    // settings): the object is selected in BOSS's scene and edited as BOSS's sidebar does
    json object_config(size_t object_id, const json& values, const std::vector<std::string>& remove)
    {
        ModelObject* o = find_object(object_id);
        if (o->instances.empty())
            throw std::runtime_error("the object has no instance");
        select(Biz::Scene::SelectionMode::Instance, ElementRef(o->id().id, o->instances[0]->id().id));
        web::set_overrides(m_rt.pi(), false, values, remove);
        settle();
        return json::object();
    }

    // Adds a part, modifier, negative volume, support enforcer or blocker to an object, as
    // BOSS's object menu does: a cube, cylinder or sphere a tenth of the bed's size next to the
    // object
    json add_volume(size_t object_id, const std::string& type_name, const std::string& shape)
    {
        ModelObject* o = find_object(object_id);
        const ModelVolumeType type = volume_type_of(type_name);
        if (o->instances.empty())
            throw std::runtime_error("the object has no instance");
        // BOSS's unit shapes (GeometryDataFactory), which it scales to the bed
        indexed_triangle_set its;
        std::string label;
        if (shape == "box") {
            its = Biz::Algorithms::TriangleMesh::its_make_cube(1., 1., 1.);
            label = "Cube";
        } else if (shape == "cylinder") {
            its = Biz::Algorithms::TriangleMesh::its_make_cylinder(0.5, 1.);
            label = "Cylinder";
        } else if (shape == "sphere") {
            its = Biz::Algorithms::TriangleMesh::its_make_sphere(0.5, 2 * M_PI / 120);
            label = "Sphere";
        } else
            throw std::runtime_error("unknown shape: " + shape);

        Biz::Scene::SceneInteractor& scene = m_rt.pi().scene_interactor();
        select(Biz::Scene::SelectionMode::Instance, ElementRef(o->id().id, o->instances[0]->id().id));
        scene.add_volume_to_active_object(its, type, label);
        settle();
        // BOSS selects the volume it added
        const auto added = scene.object_selection().elements;
        if (type == ModelVolumeType::MODEL_PART)
            drop_to_bed(*o);
        json out = json::object();
        if (!added.empty())
            out["added"] = added.front().volume_id;
        return out;
    }

    // Moves / rotates / scales a volume within its object (matrix in the object's coordinates)
    json volume_transform(size_t object_id, size_t volume_id, const json& matrix)
    {
        auto [o, v] = find_volume(object_id, volume_id);
        m_rt.pi().scene_interactor().set_element_transforms({ { ElementRef(o->id().id, 0, v->id().id), matrix_of(matrix) } });
        settle();
        if (v->is_model_part())
            drop_to_bed(*o);
        return json::object();
    }

    json delete_volume(size_t object_id, size_t volume_id)
    {
        auto [o, v] = find_volume(object_id, volume_id);
        select(Biz::Scene::SelectionMode::Volume, ElementRef(o->id().id, o->instances[0]->id().id, v->id().id));
        const auto last_part = m_rt.pi().scene_interactor().delete_selected_elements();
        settle();
        if (last_part)
            throw std::runtime_error("an object needs at least one part; delete the object instead");
        drop_to_bed(*o);
        return json::object();
    }

    // A part's or modifier's own settings, overriding the object's
    json volume_config(size_t object_id, size_t volume_id, const json& values, const std::vector<std::string>& remove)
    {
        auto [o, v] = find_volume(object_id, volume_id);
        if (!v->is_model_part() && !v->is_modifier())
            throw std::runtime_error("only parts and modifiers have settings");
        select(Biz::Scene::SelectionMode::Volume, ElementRef(o->id().id, o->instances[0]->id().id, v->id().id));
        web::set_overrides(m_rt.pi(), true, values, remove);
        settle();
        return json::object();
    }

    json load(const std::string& path)
    {
        auto model = Biz::FileLoadingLogic::read_model_from_file(path, nullptr);
        if (!model.has_value())
            throw std::runtime_error(model.error());
        if (model->objects.empty())
            throw std::runtime_error("no objects in " + fs::path(path).filename().string());
        const bool plate_was_empty = project().model().objects.empty();
        m_rt.pi().scene_interactor().add_new_objects(model->objects);
        settle();
        // A lone first object goes to the middle of the bed; more get arranged
        if (plate_was_empty && model->objects.size() == 1)
            center_on_bed(*project().model().objects.front());
        else
            arrange_plate();
        return json::object();
    }

    json add_shape(const std::string& shape, double size)
    {
        if (!(size > 0 && size < 10000))
            throw std::runtime_error("size must be between 0 and 10000 mm");
        indexed_triangle_set its;
        if (shape == "cube")
            its = Biz::Algorithms::TriangleMesh::its_make_cube(size, size, size);
        else if (shape == "sphere")
            its = Biz::Algorithms::TriangleMesh::its_make_sphere(size / 2., 2 * M_PI / 120);
        else
            throw std::runtime_error("unknown shape: " + shape);
        // Through a file, like any model: BOSS places and names it the same way
        const std::string path = shape + ".stl";
        write_stl(its, path);
        return load(path);
    }

    json transform(size_t object_id, size_t instance_idx, const json& matrix)
    {
        ModelObject* o = find_object(object_id);
        if (instance_idx >= o->instances.size())
            throw std::runtime_error("no such instance");
        Domain::SquareMatrix4d m = matrix_of(matrix);
        // Back on the bed, as BOSS's plater keeps it: the lowest point of its parts at z = 0
        const double z = lowest_z(*o, m);
        m(2, 3) -= z;
        m_rt.pi().scene_interactor().set_element_transforms(
            { { ElementRef(object_id, o->instances[instance_idx]->id().id), m } });
        settle();
        return json::object();
    }

    json remove(size_t object_id)
    {
        m_rt.pi().scene_interactor().delete_object(find_object(object_id));
        settle();
        return json::object();
    }

    json clear()
    {
        const auto objects = project().model().objects;
        for (ModelObject* o : objects)
            m_rt.pi().scene_interactor().delete_object(o);
        settle();
        return json::object();
    }

    json arrange()
    {
        arrange_plate();
        return json::object();
    }

    json slice()
    {
        ProjectInteractor& pi = m_rt.pi();
        if (project().model().objects.empty())
            throw std::runtime_error("nothing to slice: add a model first");
        const Domain::SlicingId id = pi.selected_bed_slicing_id();
        const Domain::BedInstance* bed = project().find_bed_instance_by_id(id.bed_instance_id);
        if (!bed)
            throw std::runtime_error("no bed is selected");

        const auto t0 = std::chrono::steady_clock::now();
        const Domain::ConfigContainer& cc = pi.selected_config_container();
        pi.slicing_interactor().update_process(project().model(), project().metadata(),
                                               cc.selected_preset().metadata(), cc.build_print_config(), *bed);
        pi.slicing_interactor().slice_bed(id);

        Biz::StatusCache& statuses = pi.status_cache();
        double last_percent = -1;
        m_rt.wait_until(
            [&]() {
                const auto s = statuses.get_status(id);
                using C = Biz::Slicing::StatusCode;
                return s && (s->code == C::Empty || s->code == C::Removed || s->code == C::Finished || s->code == C::InvalidData);
            },
            [&]() {
                const auto s = statuses.get_status(id);
                if (s && s->progress && s->progress->progress.value != last_percent) {
                    last_percent = s->progress->progress.value;
                    emit({ { "event", "progress" }, { "percent", last_percent }, { "text", "" } });
                }
            });
        const Biz::Slicing::Status status = statuses.get_status(id).value();
        using C = Biz::Slicing::StatusCode;
        if (status.code == C::Empty)
            throw std::runtime_error("nothing to print: no object is fully inside the print volume");
        if (status.code == C::Removed)
            throw std::runtime_error("the slicing job was removed");
        if (status.code == C::InvalidData) {
            std::string message;
            for (const auto& e : status.errors)
                message += (message.empty() ? "" : "\n") + App::to_display_string(e, project());
            throw std::runtime_error(message.empty() ? "the print can't be sliced" : message);
        }
        const long long process_ms = ms_since(t0);

        // G-code, binary when the printer wants it, as BOSS's CLI decides
        const auto t1 = std::chrono::steady_clock::now();
        const Domain::ConfigPack pack = cc.build_print_config();
        bool binary = false;
        if (const auto* fdm = std::get_if<ConfigPackFDM>(&pack))
            if (const Domain::ConfigItem* item = fdm->printer.items.find("binary_gcode"))
                binary = item->get<bool>();
        const std::string gcode_file = binary ? "output.bgcode" : "output.gcode";
        export_gcode(id, (fs::current_path() / gcode_file).string());
        const long long export_ms = ms_since(t1);

        std::string output_name = gcode_file;
        try {
            const auto name = Biz::ExportNameParser::parse_export_name(pi);
            // BOSS's name, with the extension of the file actually written
            if (!name.filename.empty())
                output_name = fs::path(name.filename).replace_extension(fs::path(gcode_file).extension()).string();
        } catch (const std::exception&) {
            // the output file name format didn't work out; keep the plain name
        }

        const auto result = pi.fdm_result_cache().get_result(id);
        if (!result)
            throw std::runtime_error("slicing finished without a result");
        const auto& r = result->get();
        const json preview = write_preview(*r.const_moves(), "preview.bin");

        json stats = { { "print_time", "" }, { "filament_mm", 0 }, { "filament_g", 0 }, { "cost", 0 },
                       { "layers", preview["layers"] } };
        if (const auto* full = std::get_if<Domain::FullPrintStatistics>(&r.print_statistics)) {
            stats["print_time"]  = format_time(full->normal_mode_time.time);
            stats["filament_mm"] = full->total_used_filament_mm;
            stats["filament_g"]  = full->total_used_filament_g;
            stats["cost"]        = full->total_filament_cost;
        } else if (const auto* basic = std::get_if<Domain::BasicPrintStatistics>(&r.print_statistics))
            stats["print_time"] = format_time(basic->normal_mode_time.time);

        return { { "apply_status", "changed" },
                 { "ms", { { "apply", 0 }, { "process", process_ms }, { "export", export_ms } } },
                 { "gcode", gcode_file },
                 { "output_name", output_name },
                 { "preview", preview },
                 { "stats", stats } };
    }

    // The whole plate as the browser draws it, with the offered presets
    json state() const
    {
        json out = plate_fields(true);
        json objects = json::array();
        for (const ModelObject* o : project().model().objects)
            objects.push_back(object_json(*o));
        out["objects"] = objects;
        return { { "state", out }, { "settings", settings() } };
    }

private:
    // One object as the browser draws it: its parts with their meshes and matrices, its
    // instances, and its own settings
    static json object_json(const ModelObject& o)
    {
        json instances = json::array();
        for (const auto* i : o.instances)
            instances.push_back({ { "id", i->id().id }, { "matrix", matrix_values(i->get_matrix()) } });
        json volumes = json::array();
        for (const ModelVolume* v : o.volumes) {
            ensure_mesh_file(*v);
            volumes.push_back({ { "id", v->id().id }, { "name", v->name }, { "type", volume_type_name(v->type()) },
                                { "mesh", mesh_file(*v) }, { "matrix", matrix_values(v->get_matrix()) },
                                { "settings", web::override_values(v->volume_settings) } });
        }
        const auto size = object_size(o);
        return { { "id", o.id().id }, { "name", o.name }, { "volumes", volumes },
                 { "instances", instances }, { "size", { size[0], size[1], size[2] } },
                 { "settings", web::override_values(o.object_settings) } };
    }

    // The plate's own fields: presets, the sidebar's settings, the bed, the G-code
    // thumbnails; with the offered presets when asked
    json plate_fields(bool with_choices) const
    {
        json out = { { "presets", nullptr } };
        auto is_user = [this](const std::string& name) {
            return std::find(m_user_names.begin(), m_user_names.end(), name) != m_user_names.end();
        };
        if (!m_vendor.empty())
            out["presets"] = { { "vendor", m_vendor }, { "printer", m_printer_name }, { "print", m_print_name },
                               { "filament", m_filament_name },
                               { "user", { { "print", is_user(m_print_name) }, { "filament", is_user(m_filament_name) },
                                           { "printer", m_user_printer } } } };

        const Domain::ConfigContainer& cc = m_rt.pi().selected_config_container();
        const Domain::ConfigPack pack = cc.build_print_config();
        json settings = json::object();
        const json print_values = web::tab_values(m_rt.pi())["print"];
        for (const char* key : SIDEBAR_SETTINGS)
            if (print_values.contains(key))
                settings[key] = print_values[key];
        out["settings"] = settings;
        out["bed"] = bed_json(cc);
        // The G-code thumbnails the printer wants ("16x16/QOI, 313x173/QOI, ..."), which the
        // browser draws before slicing
        std::string thumbnails;
        if (const auto* fdm = std::get_if<ConfigPackFDM>(&pack))
            if (const Domain::ConfigItem* item = fdm->printer.items.find("thumbnails")) {
                const auto value = Biz::value_as_string(*item);
                if (const auto* text = std::get_if<std::string>(&value))
                    thumbnails = *text;
                else
                    for (const std::string& part : std::get<std::vector<std::string>>(value))
                        thumbnails += (thumbnails.empty() ? "" : ", ") + part;
            }
        out["thumbnails"] = thumbnails;
        if (with_choices)
            out["choices"] = { { "prints", m_print_choices }, { "filaments", m_filament_choices }, { "user", m_user_names },
                               { "printers", user_printers() } };
        return out;
    }

    Domain::Project& project() { return m_rt.pi().selected_project(); }
    const Domain::Project& project() const { return m_rt.pi().selected_project(); }

    // Lets BOSS finish the work a change queued on the main thread
    void settle()
    {
        while (m_rt.dispatcher().dispatch_enqueued()) {}
    }

    static long long ms_since(std::chrono::steady_clock::time_point t0)
    {
        return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t0).count();
    }

    static std::pair<std::string, std::string> pick(const std::vector<std::pair<std::string, std::string>>& choices,
                                                    std::initializer_list<std::string> wanted)
    {
        for (const std::string& w : wanted)
            for (const auto& c : choices)
                if (!w.empty() && c.first == w)
                    return c;
        return choices.front();
    }

    ModelObject* find_object(size_t id)
    {
        for (ModelObject* o : project().model().objects)
            if (o->id().id == id)
                return o;
        throw std::runtime_error("no such object: " + std::to_string(id));
    }

    std::pair<ModelObject*, ModelVolume*> find_volume(size_t object_id, size_t volume_id)
    {
        ModelObject* o = find_object(object_id);
        for (ModelVolume* v : o->volumes)
            if (v->id().id == volume_id)
                return { o, v };
        throw std::runtime_error("no such part: " + std::to_string(volume_id));
    }

    static ModelVolumeType volume_type_of(const std::string& name)
    {
        if (name == "part")             return ModelVolumeType::MODEL_PART;
        if (name == "negative")         return ModelVolumeType::NEGATIVE_VOLUME;
        if (name == "modifier")         return ModelVolumeType::PARAMETER_MODIFIER;
        if (name == "support_enforcer") return ModelVolumeType::SUPPORT_ENFORCER;
        if (name == "support_blocker")  return ModelVolumeType::SUPPORT_BLOCKER;
        throw std::runtime_error("unknown volume type: " + name);
    }

    // Selects one element in BOSS's scene: what its object settings and object menu act on
    void select(Biz::Scene::SelectionMode mode, const ElementRef& element)
    {
        Biz::Scene::ObjectSelection selection;
        selection.mode = mode;
        selection.elements = { element };
        m_rt.pi().scene_interactor().set_object_selection(selection);
        settle();
    }

    // Puts each instance back on the bed after its parts changed: their lowest point at z = 0
    void drop_to_bed(const ModelObject& o)
    {
        Biz::Scene::SceneInteractor::ElementTransforms moves;
        for (const auto* i : o.instances) {
            Domain::SquareMatrix4d m = i->get_matrix().matrix();
            const double z = lowest_z(o, m);
            if (std::abs(z) < 1e-6)
                continue;
            m(2, 3) -= z;
            moves.emplace(ElementRef(o.id().id, i->id().id), m);
        }
        if (moves.empty())
            return;
        m_rt.pi().scene_interactor().set_element_transforms(moves);
        settle();
    }

    // Moves an object's first instance so it sits in the middle of the first bed, on it
    void center_on_bed(ModelObject& o)
    {
        if (o.instances.empty())
            return;
        const Domain::ConfigContainer& cc = m_rt.pi().selected_config_container();
        const Domain::Bed& bed = cc.bed();
        Domain::Transform3d placement = Domain::Transform3d::Identity();
        if (!cc.bed_instances().empty())
            placement = cc.bed_instances().front()->matrix();
        const Domain::Vec2d c2 = (bed.contour_aabb().min + bed.contour_aabb().max) / 2.;
        const Eigen::Vector3d target = placement * Eigen::Vector3d(c2.x(), c2.y(), 0.);

        Domain::SquareMatrix4d m = o.instances[0]->get_matrix().matrix();
        // Center of the parts' footprint under the current matrix
        Eigen::Vector3d lo = Eigen::Vector3d::Constant(std::numeric_limits<double>::max()), hi = -lo;
        for (const ModelVolume* v : o.volumes) {
            if (!v->is_model_part())
                continue;
            const Domain::SquareMatrix4d mv = m * v->get_matrix().matrix();
            for (const auto& p : v->mesh().its.vertices) {
                const Eigen::Vector3d w = (mv * Eigen::Vector4d(p.x(), p.y(), p.z(), 1.)).head<3>();
                lo = lo.cwiseMin(w);
                hi = hi.cwiseMax(w);
            }
        }
        if (lo.x() > hi.x())
            return;
        m(0, 3) += target.x() - (lo.x() + hi.x()) / 2.;
        m(1, 3) += target.y() - (lo.y() + hi.y()) / 2.;
        m(2, 3) -= lo.z();
        m_rt.pi().scene_interactor().set_element_transforms(
            { { ElementRef(o.id().id, o.instances[0]->id().id), m } });
        settle();
    }

    // The lowest point of an object's parts under an instance matrix
    static double lowest_z(const ModelObject& o, const Domain::SquareMatrix4d& instance)
    {
        double z = std::numeric_limits<double>::max();
        for (const ModelVolume* v : o.volumes) {
            if (!v->is_model_part())
                continue;
            const Domain::SquareMatrix4d m = instance * v->get_matrix().matrix();
            for (const auto& p : v->mesh().its.vertices)
                z = std::min(z, (m * Eigen::Vector4d(p.x(), p.y(), p.z(), 1.)).z());
        }
        return z == std::numeric_limits<double>::max() ? 0. : z;
    }

    // Size of an object's first instance, from its parts
    static std::array<double, 3> object_size(const ModelObject& o)
    {
        if (o.instances.empty())
            return { 0, 0, 0 };
        Eigen::Vector3d lo = Eigen::Vector3d::Constant(std::numeric_limits<double>::max()), hi = -lo;
        for (const ModelVolume* v : o.volumes) {
            if (!v->is_model_part())
                continue;
            const Domain::SquareMatrix4d m = o.instances[0]->get_matrix().matrix() * v->get_matrix().matrix();
            for (const auto& p : v->mesh().its.vertices) {
                const Eigen::Vector3d w = (m * Eigen::Vector4d(p.x(), p.y(), p.z(), 1.)).head<3>();
                lo = lo.cwiseMin(w);
                hi = hi.cwiseMax(w);
            }
        }
        if (lo.x() > hi.x())
            return { 0, 0, 0 };
        return { hi.x() - lo.x(), hi.y() - lo.y(), hi.z() - lo.z() };
    }

    // The bed as the browser draws it: the first bed's outline where it sits in the scene
    static json bed_json(const Domain::ConfigContainer& cc)
    {
        const Domain::Bed& bed = cc.bed();
        Domain::Transform3d placement = Domain::Transform3d::Identity();
        if (!cc.bed_instances().empty())
            placement = cc.bed_instances().front()->matrix();
        json shape = json::array();
        for (const auto& p : bed.contour()) {
            const Eigen::Vector3d w = placement * Eigen::Vector3d(p.x(), p.y(), 0.);
            shape.push_back({ w.x(), w.y() });
        }
        return { { "shape", shape }, { "max_height", bed.max_print_height() } };
    }

    // BOSS's arrange, as its CLI runs it (ProcessTransform.cpp, arrange_and_wait)
    void arrange_plate()
    {
        ProjectInteractor& pi = m_rt.pi();
        if (project().model().objects.empty())
            return;
        const Domain::ConfigContainer& cc = pi.selected_config_container();
        const double distance = std::max(6., App::CLI::min_object_distance(cc.build_print_config()));
        const double scaled_offset = double(Biz::Algorithms::Scaling::scaled(distance)) / 2.;
        Domain::ConstModelInstanceList instances;
        std::vector<Biz::BedToArrange> beds;
        for (const auto& bed : cc.bed_instances()) {
            instances.insert(instances.end(), bed->model_instances.begin(), bed->model_instances.end());
            beds.push_back({ Domain::BedRef{ cc.id().id, bed->id().id }, bed->index() });
        }
        const auto& unplaced = pi.scene_interactor().unplaced_model_instances(pi.selected_project_id());
        instances.insert(instances.end(), unplaced.begin(), unplaced.end());
        bool done = false;
        pi.arrange_interactor().arrange(pi.selected_project_id(), beds, cc.id().id, instances,
                                        Biz::Arrange::Settings{ .scaled_offset = scaled_offset }, [&done]() { done = true; });
        m_rt.wait_until([&done]() { return done; });
    }

    // Writes the bed's result as G-code (BOSS binarizes it for a .bgcode path) and waits for
    // the export job, as BOSS's CLI does
    void export_gcode(const Domain::SlicingId& id, const std::string& path)
    {
        auto& jobs = Biz::Platform::PlatformServices::instance().job_manager();
        App::CLI::ExportFinishedJobManagerStatusListener listener;
        jobs.add_listener<Biz::Platform::JobManager::IJobManagerStatusChangedListener>(&listener);
        m_rt.pi().do_result_export(id, path, "");
        // A failed binarization only logs, so the wait is bounded
        const auto t0 = std::chrono::steady_clock::now();
        m_rt.wait_until([&]() { return listener.export_finished || ms_since(t0) > 120000; });
        jobs.remove_listener<Biz::Platform::JobManager::IJobManagerStatusChangedListener>(&listener);
        if (listener.export_error)
            throw std::runtime_error("could not write the G-code: " + *listener.export_error);
        if (!listener.export_finished)
            throw std::runtime_error("writing the G-code timed out");
    }

    static std::string mesh_file(const ModelVolume& v) { return "mesh-" + std::to_string(v.id().id) + ".bin"; }

    // Binary mesh for the browser, one per volume, in the volume's own coordinates (volume
    // and instance matrices place it): "PSWM", uint32 vertex count, uint32 triangle count,
    // float32 xyz per vertex, uint32 indices per triangle. Little-endian. Written once: a
    // volume's mesh doesn't change, only its matrix.
    static void ensure_mesh_file(const ModelVolume& v)
    {
        const std::string file = mesh_file(v);
        if (fs::exists(file))
            return;
        const auto& its = v.mesh().its;
        std::ofstream f(file, std::ios::binary);
        const uint32_t counts[2] = { uint32_t(its.vertices.size()), uint32_t(its.indices.size()) };
        f.write("PSWM", 4);
        f.write(reinterpret_cast<const char*>(counts), sizeof(counts));
        for (const auto& p : its.vertices) {
            const float xyz[3] = { float(p.x()), float(p.y()), float(p.z()) };
            f.write(reinterpret_cast<const char*>(xyz), sizeof(xyz));
        }
        for (const auto& t : its.indices) {
            const uint32_t abc[3] = { uint32_t(t[0]), uint32_t(t[1]), uint32_t(t[2]) };
            f.write(reinterpret_cast<const char*>(abc), sizeof(abc));
        }
        if (!f)
            throw std::runtime_error("could not write " + file);
    }

    static void write_stl(const indexed_triangle_set& its, const std::string& path)
    {
        std::ofstream f(path, std::ios::binary);
        char header[80] = "prusaslicer-web-boss shape";
        f.write(header, 80);
        const uint32_t n = uint32_t(its.indices.size());
        f.write(reinterpret_cast<const char*>(&n), 4);
        for (const auto& t : its.indices) {
            float data[12] = {};
            for (int k = 0; k < 3; ++k)
                for (int c = 0; c < 3; ++c)
                    data[3 + k * 3 + c] = float(its.vertices[t[k]][c]);
            const uint16_t attr = 0;
            f.write(reinterpret_cast<const char*>(data), sizeof(data));
            f.write(reinterpret_cast<const char*>(&attr), 2);
        }
    }

    // Toolpaths for the browser, one segment per extrusion/travel/wipe move: "PSWP", uint32
    // version, uint32 segment count n, then arrays of n: float32 xyz start, float32 xyz end,
    // float32 width, float32 height, float32 feedrate (mm/s), uint32 layer, and uint8 move
    // type, uint8 feature (extrusion role), uint8 extruder. Move types and roles are numbered
    // as in BOSS (libpgcode MoveType, GCodeExtrusionRole).
    static json write_preview(const std::vector<Biz::libpgcode::MoveVertex>& moves, const std::string& path)
    {
        using MoveType = Biz::libpgcode::MoveType;
        std::vector<float> start, end, width, height, feedrate;
        std::vector<uint32_t> layer;
        std::vector<uint8_t> type, role, extruder;
        uint32_t layers = 0;
        for (size_t i = 1; i < moves.size(); ++i) {
            const auto& m = moves[i];
            if (m.type != MoveType::Extrude && m.type != MoveType::Travel && m.type != MoveType::Wipe)
                continue;
            const auto& a = moves[i - 1].position;
            if (a == m.position)
                continue;
            start.insert(start.end(), { a.x(), a.y(), a.z() });
            end.insert(end.end(), { m.position.x(), m.position.y(), m.position.z() });
            width.push_back(m.width);
            height.push_back(m.height);
            feedrate.push_back(m.feedrate);
            layer.push_back(m.layer_id);
            type.push_back(uint8_t(m.type));
            role.push_back(uint8_t(m.extrusion_role));
            extruder.push_back(m.extruder_id);
            layers = std::max(layers, m.layer_id + 1);
        }
        std::ofstream f(path, std::ios::binary);
        const uint32_t header[2] = { 1, uint32_t(layer.size()) };
        f.write("PSWP", 4);
        f.write(reinterpret_cast<const char*>(header), sizeof(header));
        auto put = [&f](const auto& v) { f.write(reinterpret_cast<const char*>(v.data()), v.size() * sizeof(v[0])); };
        put(start); put(end); put(width); put(height); put(feedrate); put(layer);
        put(type); put(role); put(extruder);
        if (!f)
            throw std::runtime_error("could not write " + path);
        return { { "file", path }, { "segments", layer.size() }, { "layers", layers } };
    }

    Runtime& m_rt;
    // The selected presets' own values (tab_values), which change marks and resets go by
    json m_saved_values;
    std::string m_vendor, m_printer_name, m_print_name, m_filament_name;
    std::vector<std::string> m_print_choices, m_filament_choices;
    // The user's own presets among the offered prints and filaments; whether the printer is one
    std::vector<std::string> m_user_names;
    bool m_user_printer = false;
    // What BOSS changed since the last reply
    ChangeTracker m_changes;
};

json handle(Project& project, const json& msg)
{
    const std::string cmd = msg.value("cmd", "");
    json reply;
    if (cmd == "hello")
        reply = { { "engine", "prusaslicer-web-boss" }, { "slicer", SLIC3R_VERSION } };
    else if (cmd == "catalog")
        reply = { { "vendors", project.catalog() } };
    else if (cmd == "schema")
        reply = web::settings_schema();
    else if (cmd == "select_presets")
        reply = project.select_presets(msg.value("vendor", ""), msg.at("printer").get<std::string>(),
                                       msg.value("print", ""), msg.value("filament", ""), msg.value("transfer", false));
    else if (cmd == "set")
        reply = project.set(msg.at("config"), msg.value("preset", ""));
    else if (cmd == "reset")
        reply = project.reset(msg.at("preset").get<std::string>(), msg.value("keys", std::vector<std::string>{}));
    else if (cmd == "settings")
        reply = { { "settings", project.settings() } };
    else if (cmd == "save_preset")
        reply = project.save_preset(msg.at("preset").get<std::string>(), msg.at("name").get<std::string>());
    else if (cmd == "object_config")
        reply = project.object_config(msg.at("object").get<size_t>(), msg.value("set", json::object()),
                                      msg.value("remove", std::vector<std::string>{}));
    else if (cmd == "add_volume")
        reply = project.add_volume(msg.at("object").get<size_t>(), msg.at("type").get<std::string>(),
                                   msg.at("shape").get<std::string>());
    else if (cmd == "volume_transform")
        reply = project.volume_transform(msg.at("object").get<size_t>(), msg.at("volume").get<size_t>(), msg.at("matrix"));
    else if (cmd == "delete_volume")
        reply = project.delete_volume(msg.at("object").get<size_t>(), msg.at("volume").get<size_t>());
    else if (cmd == "volume_config")
        reply = project.volume_config(msg.at("object").get<size_t>(), msg.at("volume").get<size_t>(),
                                      msg.value("set", json::object()), msg.value("remove", std::vector<std::string>{}));
    else if (cmd == "load")
        reply = project.load(msg.at("path").get<std::string>());
    else if (cmd == "add_shape")
        reply = project.add_shape(msg.at("shape").get<std::string>(), msg.value("size", 20.0));
    else if (cmd == "transform")
        reply = project.transform(msg.at("object").get<size_t>(), msg.value("instance", size_t(0)), msg.at("matrix"));
    else if (cmd == "delete")
        reply = project.remove(msg.at("object").get<size_t>());
    else if (cmd == "clear")
        reply = project.clear();
    else if (cmd == "arrange")
        reply = project.arrange();
    else if (cmd == "state") {
        reply = project.state();
        project.drop_changes();
    }
    else if (cmd == "slice")
        reply = project.slice();
    else
        throw std::runtime_error("unknown command: " + cmd);
    reply["event"] = cmd;
    if (json changes = project.take_changes(); !changes.is_null())
        reply["changes"] = std::move(changes);
    return reply;
}

} // namespace

int main()
{
    // Keep stdout for events: anything else that writes there (BOSS's logging can) goes to
    // stderr instead
    fflush(stdout);
    if (const int fd = dup(STDOUT_FILENO); fd >= 0 && (events_out = fdopen(fd, "w")) != nullptr)
        dup2(STDERR_FILENO, STDOUT_FILENO);
    else
        events_out = stdout;

    try {
        // BOSS's startup, as its launcher does it: resources next to the program
        // (../resources), and a data folder for presets (shared by every project on this
        // server, so saved presets are too)
        App::InitParams params;
        if (const char* data = std::getenv("ENGINE_DATA_DIR"))
            params.misc.datadir = std::string(data);
        App::init_common();
        App::init_paths(params);
        App::AppServices& services = App::AppServices::instance();
        services.set_app_config(App::AppConfig::create_app_config());
        services.set_dialog_manager(std::make_unique<HeadlessDialogManager>());

        Runtime runtime;
        runtime.pi().preset_interactor().load_preset_bundle(Biz::Preset::IO::BundlePaths::make_standard_runtime());
        Project project(runtime);

        std::string line;
        while (std::getline(std::cin, line)) {
            if (line.empty())
                continue;
            json msg;
            try {
                msg = json::parse(line);
                if (msg.value("cmd", "") == "quit")
                    break;
                json reply = handle(project, msg);
                if (msg.contains("id"))
                    reply["id"] = msg["id"];
                emit(reply);
            } catch (const std::exception& e) {
                json err = { { "event", "error" }, { "message", e.what() } };
                if (msg.is_object()) {
                    if (msg.contains("id"))
                        err["id"] = msg["id"];
                    err["cmd"] = msg.value("cmd", "");
                }
                // A command that failed half-way may still have changed things
                try {
                    if (json changes = project.take_changes(); !changes.is_null())
                        err["changes"] = std::move(changes);
                } catch (const std::exception&) {
                    // the next reply carries them
                }
                emit(err);
            }
        }
    } catch (const std::exception& e) {
        emit({ { "event", "fatal" }, { "message", e.what() } });
        return 1;
    }
    return 0;
}
