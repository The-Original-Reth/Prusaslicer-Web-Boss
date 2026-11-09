#include "settings.hpp"

#include <algorithm>
#include <cmath>
#include <set>
#include <sstream>
#include <typeinfo>

#include "Slic3r/Biz/Config/ConfigLoad.hpp"
#include "Slic3r/Biz/Config/ConfigSerialize.hpp"
#include "Slic3r/Biz/Preset/PresetInteractor.hpp"
#include "Slic3r/Biz/ProjectInteractor.hpp"
#include "Slic3r/Domain/Config.hpp"
#include "Slic3r/Domain/ConfigDef.hpp"
#include "Slic3r/Domain/ConfigDefsFDM.hpp"
#include "Slic3r/Domain/ConfigPack.hpp"

using json = nlohmann::json;
using namespace Slic3r;
using Domain::ConfigItemDef;
using Domain::FDMConfigLocation;

namespace web {

namespace {

// What kind of value an option holds, and whether it's a list of them
enum class Kind { Bool, Int, OptInt, Float, String, Point, FloatOrPercent, Percent, Enum, Other };
struct TypeOf {
    Kind kind;
    bool vector;
};

TypeOf type_of(const ConfigItemDef& d)
{
    const std::type_info& t = *d.type;
    if (t == typeid(bool)) return { Kind::Bool, false };
    if (t == typeid(int)) return { Kind::Int, false };
    if (t == typeid(std::optional<int>)) return { Kind::OptInt, false };
    if (t == typeid(double)) return { Kind::Float, false };
    if (t == typeid(std::string)) return { Kind::String, false };
    if (t == typeid(Domain::Vec2d)) return { Kind::Point, false };
    if (t == typeid(Domain::FloatOrPercentage)) return { Kind::FloatOrPercent, false };
    if (t == typeid(Domain::Percentage)) return { Kind::Percent, false };
    if (t == typeid(Domain::EnumWrapper)) return { Kind::Enum, false };
    if (t == typeid(std::vector<bool>)) return { Kind::Bool, true };
    if (t == typeid(std::vector<int>)) return { Kind::Int, true };
    if (t == typeid(std::vector<std::optional<int>>)) return { Kind::OptInt, true };
    if (t == typeid(std::vector<double>)) return { Kind::Float, true };
    if (t == typeid(std::vector<std::string>)) return { Kind::String, true };
    if (t == typeid(std::vector<Domain::Vec2d>)) return { Kind::Point, true };
    if (t == typeid(std::vector<Domain::FloatOrPercentage>)) return { Kind::FloatOrPercent, true };
    if (t == typeid(std::vector<Domain::Percentage>)) return { Kind::Percent, true };
    if (t == typeid(Domain::EnumVectorWrapper)) return { Kind::Enum, true };
    return { Kind::Other, false };
}

const char* kind_name(Kind k)
{
    switch (k) {
    case Kind::Bool:           return "bool";
    case Kind::Int:
    case Kind::OptInt:         return "int";
    case Kind::Float:          return "float";
    case Kind::String:         return "string";
    case Kind::Point:          return "point";
    case Kind::FloatOrPercent: return "float_or_percent";
    case Kind::Percent:        return "percent";
    case Kind::Enum:           return "enum";
    default:                   return "none";
    }
}

std::optional<FDMConfigLocation> fdm_location(const ConfigItemDef& d)
{
    if (const auto* l = std::get_if<FDMConfigLocation>(&d.location))
        return *l;
    return std::nullopt;
}

// Per-tool and per-filament settings have one value per tool / material slot
bool per_slot(const ConfigItemDef& d)
{
    const auto l = fdm_location(d);
    return l && (*l == FDMConfigLocation::Tool || *l == FDMConfigLocation::Filament);
}

// The tab a category belongs to: BOSS numbers them Print 1xx, Filament 2xx, Printer 3xx
std::string tab_of_category(ConfigItemDef::Category c)
{
    const int n = int(c);
    if (n >= 100 && n < 200) return "print";
    if (n >= 200 && n < 300) return "filament";
    if (n >= 300 && n < 400) return "printer";
    return "";
}

const ConfigItemDef* find(const std::string& key)
{
    for (const ConfigItemDef& d : Domain::get_defs_fdm().defs())
        if (d.name == key)
            return &d;
    return nullptr;
}

std::string number_text(double v)
{
    std::ostringstream s;
    s << v;
    return s.str();
}

// Allowed values with their labels: an enum's own list, or an open choice's suggestions
void add_choices(const ConfigItemDef& d, json& out)
{
    json values = json::array(), labels = json::array();
    if (type_of(d).kind == Kind::Enum && d.init_fn) {
        Domain::ConfigItem item(d, d.location);
        item.visit([&](auto&& v) {
            using V = std::remove_cvref_t<decltype(v)>;
            if constexpr (std::is_same_v<V, Domain::EnumWrapper> || std::is_same_v<V, Domain::EnumVectorWrapper>)
                for (const auto& e : v.def()) {
                    values.push_back(e.str_serialized);
                    labels.push_back(e.str_ui.empty() ? e.str_serialized : e.str_ui);
                }
        });
    }
    for (const auto& [value, label] : d.choices) {
        std::visit([&](auto&& v) {
            using V = std::remove_cvref_t<decltype(v)>;
            if constexpr (std::is_same_v<V, std::string>)
                values.push_back(v);
            else
                values.push_back(number_text(double(v)));
        }, value);
        labels.push_back(label);
    }
    if (!values.empty()) {
        out["enum_values"] = values;
        out["enum_labels"] = labels;
    }
}

const char* gui_type_name(ConfigItemDef::GUIType t)
{
    using G = ConfigItemDef::GUIType;
    switch (t) {
    case G::i_enum_open: return "i_enum_open";
    case G::f_enum_open: return "f_enum_open";
    case G::s_enum_open: return "select_open";
    case G::color:       return "color";
    case G::password:    return "password";
    default:             return "";
    }
}

json option_json(const ConfigItemDef& d)
{
    const TypeOf t = type_of(d);
    std::string units;
    // A value that can be either has both units: "mm or %"
    for (const std::string& u : d.units)
        units += (units.empty() ? "" : " or ") + u;
    json j = {
        { "type", kind_name(t.kind) },
        { "label", d.label },
        { "full_label", d.full_label.empty() ? d.label : d.full_label },
        { "tooltip", d.tooltip },
        { "sidetext", units },
        { "mode", "simple" },
        { "category", ConfigItemDef::translate_category(d.category, Domain::PrinterTechnology::FFF) },
    };
    if (per_slot(d))
        j["vector"] = true;
    else if (t.vector) {
        j["vector"] = true;
        j["whole"] = true;
    }
    if (d.min) j["min"] = *d.min;
    if (d.max) j["max"] = *d.max;
    if (d.multiline) j["multiline"] = true;
    if (d.full_width) j["full_width"] = true;
    if (d.height > 0) j["height"] = d.height;
    if (!d.ratio_over.empty()) j["ratio_over"] = d.ratio_over;
    if (t.kind == Kind::OptInt) j["nullable"] = true;
    if (const char* g = gui_type_name(d.gui_type); *g)
        j["gui_type"] = g;
    add_choices(d, j);
    return j;
}

// An item's value as the page shows it: "1"/"0" for booleans (as BOSS 2.9 wrote them),
// "15%" for percentages, enum names, numbers
json value_text(const Domain::ConfigItem& item)
{
    auto fix = [](std::string s) { return s == "true" ? std::string("1") : s == "false" ? std::string("0") : s; };
    const auto v = Biz::value_as_string(item);
    if (const auto* s = std::get_if<std::string>(&v))
        return fix(*s);
    json list = json::array();
    for (const std::string& s : std::get<std::vector<std::string>>(v))
        list.push_back(fix(s));
    return list;
}

// The page's text for one value, as BOSS's JSON form of that type
json text_to_json(Kind kind, const std::string& raw)
{
    std::string text = raw;
    text.erase(0, text.find_first_not_of(" \t"));
    text.erase(text.find_last_not_of(" \t") + 1);
    auto number = [](const std::string& s) {
        size_t used = 0;
        const double v = std::stod(s, &used);
        if (used != s.size())
            throw std::invalid_argument(s);
        return v;
    };
    switch (kind) {
    case Kind::Bool:
        return text == "1" || text == "true";
    case Kind::Int:
        return int(std::lround(number(text)));
    case Kind::OptInt:
        if (text.empty() || text == "nil")
            return nullptr;
        return int(std::lround(number(text)));
    case Kind::Float:
        return number(text);
    case Kind::Percent: {
        const std::string n = !text.empty() && text.back() == '%' ? text.substr(0, text.size() - 1) : text;
        return { { "value", number(n) }, { "is_percent", true } };
    }
    case Kind::FloatOrPercent: {
        const bool percent = !text.empty() && text.back() == '%';
        return { { "value", number(percent ? text.substr(0, text.size() - 1) : text) }, { "is_percent", percent } };
    }
    case Kind::Point: {
        std::string s = text;
        for (char& c : s)
            if (c == 'x' || c == 'X' || c == ',' || c == '[' || c == ']')
                c = ' ';
        std::istringstream in(s);
        double x = 0, y = 0;
        if (!(in >> x >> y))
            throw std::invalid_argument(text);
        return json::array({ x, y });
    }
    default:
        return text;
    }
}

const Domain::ConfigBox* box_of(const Domain::ConfigPackFDM& pack, FDMConfigLocation loc, size_t slot)
{
    switch (loc) {
    case FDMConfigLocation::Printer: return &pack.printer;
    case FDMConfigLocation::Print:   return &pack.print;
    case FDMConfigLocation::Project: return &pack.project;
    case FDMConfigLocation::Tool:     return slot < pack.tool.size() ? &pack.tool[slot] : nullptr;
    case FDMConfigLocation::Filament: return slot < pack.filament.size() ? &pack.filament[slot] : nullptr;
    default:                          return nullptr;
    }
}

size_t slot_count(const Domain::ConfigPackFDM& pack, FDMConfigLocation loc)
{
    return loc == FDMConfigLocation::Tool ? pack.tool.size() : loc == FDMConfigLocation::Filament ? pack.filament.size() : 1;
}

} // namespace

bool is_per_slot(const std::string& key)
{
    const ConfigItemDef* d = find(key);
    return d && per_slot(*d);
}

std::string tab_of(const std::string& key)
{
    const ConfigItemDef* d = find(key);
    return d && d->shows_on_settings_page() ? tab_of_category(d->category) : "";
}

json settings_schema()
{
    // Pages by category, groups by option group, options by their order, all in BOSS's order
    std::vector<const ConfigItemDef*> defs;
    for (const ConfigItemDef& d : Domain::get_defs_fdm().defs())
        if (d.shows_on_settings_page() && !tab_of_category(d.category).empty() && fdm_location(d) &&
            type_of(d).kind != Kind::Other)
            defs.push_back(&d);
    std::stable_sort(defs.begin(), defs.end(), [](const ConfigItemDef* a, const ConfigItemDef* b) {
        return std::tuple(int(a->category), int(a->option_group), a->order) <
               std::tuple(int(b->category), int(b->option_group), b->order);
    });

    json layout = { { "print", json::array() }, { "filament", json::array() }, { "printer", json::array() },
                    { "object_bundles", json::array() } };
    json options = json::object();
    int page_category = -1, group_option_group = -1;
    json* page = nullptr;
    json* group = nullptr;
    for (const ConfigItemDef* d : defs) {
        const std::string tab = tab_of_category(d->category);
        if (int(d->category) != page_category) {
            page_category = int(d->category);
            group_option_group = -1;
            layout[tab].push_back({ { "title", ConfigItemDef::translate_category(d->category, Domain::PrinterTechnology::FFF) },
                                    { "icon", "" }, { "groups", json::array() } });
            page = &layout[tab].back();
        }
        if (int(d->option_group) != group_option_group) {
            group_option_group = int(d->option_group);
            page->at("groups").push_back({ { "title", d->option_group == ConfigItemDef::OptionGroup::Unknown
                                                        ? std::string()
                                                        : ConfigItemDef::translate_option_group(d->option_group) },
                                           { "lines", json::array() } });
            group = &page->at("groups").back();
        }
        json option = { { "key", d->name } };
        if (d->full_width || d->multiline)
            option["full_width"] = true;
        if (d->height > 0)
            option["height"] = d->height;
        group->at("lines").push_back({ { "options", json::array({ option }) } });
        options[d->name] = option_json(*d);
    }
    // Options an object or part can override, defined even when no tab shows them
    for (bool part : { false, true })
        for (const std::string& key : object_options(part))
            if (!options.contains(key))
                if (const ConfigItemDef* d = find(key))
                    options[key] = option_json(*d);
    return { { "layout", layout }, { "options", options }, { "modes", false },
             { "object_options", object_options(false) }, { "part_options", object_options(true) } };
}

std::vector<std::string> object_options(bool part)
{
    std::vector<std::string> keys;
    const FDMConfigLocation where = part ? FDMConfigLocation::Volume : FDMConfigLocation::Object;
    for (const ConfigItemDef& d : Domain::get_defs_fdm().defs())
        if (d.overrides_in.count(Domain::ConfigLocation(where)) && type_of(d).kind != Kind::Other)
            keys.push_back(d.name);
    return keys;
}

json tab_values(const Biz::ProjectInteractor& pi)
{
    json out = { { "print", json::object() }, { "filament", json::object() }, { "printer", json::object() } };
    const Domain::ConfigPack pack = pi.selected_config_container().build_print_config();
    const auto* fdm = std::get_if<Domain::ConfigPackFDM>(&pack);
    if (!fdm)
        return out;
    for (const ConfigItemDef& d : Domain::get_defs_fdm().defs()) {
        const std::string tab = d.shows_on_settings_page() ? tab_of_category(d.category) : "";
        const auto loc = fdm_location(d);
        if (tab.empty() || !loc || type_of(d).kind == Kind::Other)
            continue;
        if (per_slot(d)) {
            json slots = json::array();
            for (size_t i = 0; i < slot_count(*fdm, *loc); ++i) {
                const Domain::ConfigBox* box = box_of(*fdm, *loc, i);
                const Domain::ConfigItem* item = box ? box->items.find(d.name) : nullptr;
                if (!item)
                    break;
                json v = value_text(*item);
                if (v.is_array()) {
                    std::string joined;
                    for (const auto& e : v)
                        joined += (joined.empty() ? "" : ",") + e.get<std::string>();
                    v = joined;
                }
                slots.push_back(v);
            }
            if (!slots.empty())
                out[tab][d.name] = slots;
        } else if (const Domain::ConfigBox* box = box_of(*fdm, *loc, 0))
            if (const Domain::ConfigItem* item = box->items.find(d.name))
                out[tab][d.name] = value_text(*item);
    }
    return out;
}

namespace {

std::string label_of(const ConfigItemDef& d)
{
    return d.full_label.empty() ? d.label : d.full_label;
}

// A setting's value from the page (its text, or a list for a whole vector), read through
// BOSS's own loader into a copy of the box the setting lives in, and checked against its
// limits. Returns that box's current item too, to tell when nothing changes.
struct Parsed {
    std::optional<Domain::ConfigItem> item;
    std::optional<Domain::ConfigItem> current;
};

Parsed parse_value(const Biz::ProjectInteractor& pi, const ConfigItemDef& d, size_t index, const json& raw)
{
    const auto loc = fdm_location(d);
    const TypeOf t = type_of(d);
    const std::string label = label_of(d);
    const std::string& key = d.name;

    // The page's text as BOSS's JSON form, then read through BOSS's own loader
    json j;
    try {
        if (t.vector && !per_slot(d)) {
            if (!raw.is_array())
                throw std::invalid_argument("list");
            j = json::array();
            for (const auto& e : raw)
                j.push_back(text_to_json(t.kind, e.is_string() ? e.get<std::string>() : e.dump()));
        } else
            j = text_to_json(t.kind, raw.is_string() ? raw.get<std::string>() : raw.dump());
    } catch (const std::exception&) {
        throw std::runtime_error("invalid value for " + label + ": " + (raw.is_string() ? raw.get<std::string>() : raw.dump()));
    }
    // Parsed into a copy of the box the setting lives in (its constructor isn't public)
    const Domain::ConfigPack pack = pi.selected_config_container().build_print_config();
    const auto* fdm = std::get_if<Domain::ConfigPackFDM>(&pack);
    const Domain::ConfigBox* current_box = fdm && loc ? box_of(*fdm, *loc, index) : nullptr;
    if (!current_box)
        throw std::runtime_error(label + " has no value #" + std::to_string(index));
    Domain::ConfigBox box = *current_box;
    const Biz::Config::BoxIssues issues = Biz::Config::load_box(json{ { key, j } }, box);
    if (const auto it = issues.find(key); it != issues.end())
        throw std::runtime_error("invalid value for " + label + ": " + it->second.message);
    const Domain::ConfigItem* parsed = box.items.find(key);
    if (!parsed)
        throw std::runtime_error("unknown setting: " + key);
    if (d.min || d.max)
        parsed->visit([&](auto&& v) {
            using V = std::remove_cvref_t<decltype(v)>;
            if constexpr (std::is_same_v<V, int> || std::is_same_v<V, double>) {
                if ((d.min && double(v) < *d.min) || (d.max && double(v) > *d.max))
                    throw std::runtime_error(label + " must be between " + number_text(d.min.value_or(-1e300)) +
                                             " and " + number_text(d.max.value_or(1e300)));
            }
        });
    Parsed out;
    out.item = *parsed;
    if (const Domain::ConfigItem* current = current_box->items.find(key))
        out.current = *current;
    return out;
}

} // namespace

void set_overrides(Biz::ProjectInteractor& pi, bool part, const json& values, const std::vector<std::string>& remove)
{
    const FDMConfigLocation where = part ? FDMConfigLocation::Volume : FDMConfigLocation::Object;
    const char* what = part ? "a part or modifier" : "one object";
    auto def_of = [&](const std::string& key) {
        const ConfigItemDef* d = find(key);
        if (!d || !fdm_location(*d))
            throw std::runtime_error("unknown setting: " + key);
        if (!d->overrides_in.count(Domain::ConfigLocation(where)) || type_of(*d).kind == Kind::Other)
            throw std::runtime_error(label_of(*d) + " can't be set for " + what);
        return d;
    };
    Biz::Preset::PresetInteractor& presets = pi.preset_interactor();
    for (const std::string& key : remove) {
        const ConfigItemDef* d = def_of(key);
        presets.set_item_override(Domain::ConfigItem(*d, where), false, 0);
    }
    for (const auto& [key, value] : values.items()) {
        const ConfigItemDef* d = def_of(key);
        const Parsed parsed = parse_value(pi, *d, 0, value);
        const Domain::ConfigItem item(*d, where);
        presets.set_item_override(item, true, 0);
        presets.set_item_value(item, parsed.item->value(), { 0 });
    }
}

json override_values(const Domain::ConfigBox& box)
{
    json out = json::object();
    for (const Domain::ConfigItem& item : box.overrides.overridden_items()) {
        json v = value_text(item);
        if (v.is_array()) {
            std::string joined;
            for (const auto& e : v)
                joined += (joined.empty() ? "" : ",") + e.get<std::string>();
            v = joined;
        }
        out[item.name()] = v;
    }
    return out;
}

bool set_setting(Biz::ProjectInteractor& pi, const std::string& key, const json& value)
{
    const ConfigItemDef* d = find(key);
    const auto loc = d ? fdm_location(*d) : std::nullopt;
    if (!d || !loc)
        throw std::runtime_error("unknown setting: " + key);
    const std::string label = label_of(*d);

    size_t index = 0;
    json raw = value;
    if (value.is_object()) {
        index = value.at("index").get<size_t>();
        raw = value.at("value");
    }
    if (!per_slot(*d) && index != 0)
        throw std::runtime_error(label + " has one value, not one per extruder");

    const Parsed parsed = parse_value(pi, *d, index, raw);
    // Unchanged: nothing to do
    if (parsed.current && parsed.current->value() == parsed.item->value())
        return false;
    pi.preset_interactor().set_item_value(Domain::ConfigItem(*d, *loc), parsed.item->value(), { index });
    return true;
}

std::map<std::string, std::vector<std::string>> modified_keys(const json& now, const json& saved)
{
    std::map<std::string, std::vector<std::string>> out = { { "print", {} }, { "filament", {} }, { "printer", {} } };
    for (const auto& [tab, values] : now.items()) {
        const json& before = saved.contains(tab) ? saved.at(tab) : json::object();
        for (const auto& [key, value] : values.items()) {
            const json old = before.contains(key) ? before.at(key) : json();
            if (value == old)
                continue;
            const ConfigItemDef* d = find(key);
            if (d && per_slot(*d) && value.is_array() && old.is_array()) {
                for (size_t i = 0; i < value.size(); ++i)
                    if (i >= old.size() || value[i] != old[i])
                        out[tab].push_back(key + "#" + std::to_string(i));
            } else
                out[tab].push_back(key);
        }
    }
    return out;
}

} // namespace web
