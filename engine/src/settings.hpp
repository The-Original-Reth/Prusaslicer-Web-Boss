// The Print / Filament / Printer Settings tabs on BOSS 3.0: what the web page needs to draw
// them (pages, groups and option definitions, all from BOSS's own option definitions) and
// the values, edits and change marks of the selected presets.
#pragma once

#include <map>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

namespace Slic3r::Biz {
class ProjectInteractor;
}
namespace Slic3r::Domain {
struct ConfigBox;
}

namespace web {

// Tabs > pages > groups > lines > options, plus every option's definition. Pages are BOSS's
// option categories, groups its option groups, in BOSS's order. 3.0 has no Simple /
// Advanced / Expert modes, so every option shows.
nlohmann::json settings_schema();

// Settings an object or one of its parts can override (their "overrides_in")
std::vector<std::string> object_options(bool part);

// The current values of each tab: {"print": {key: value}, "filament": ..., "printer": ...}.
// A value is its text ("15%", "1"), a list for a vector, or, for per-tool and per-filament
// settings, a list with one text per tool / material slot.
nlohmann::json tab_values(const Slic3r::Biz::ProjectInteractor& pi);

// Sets one setting from the page: a text, a list (a whole vector) or {"index": i, "value":
// text} (one tool's or slot's value). Returns false when the value is what it already was.
bool set_setting(Slic3r::Biz::ProjectInteractor& pi, const std::string& key, const nlohmann::json& value);

// Edits the overrides of the object (or, with `part`, the part or modifier) selected in
// BOSS's scene, as its object settings do: values as text, starting an override where there
// was none; `remove` drops overrides
void set_overrides(Slic3r::Biz::ProjectInteractor& pi, bool part, const nlohmann::json& values,
                   const std::vector<std::string>& remove);

// An object's or volume's overridden settings: {key: text}
nlohmann::json override_values(const Slic3r::Domain::ConfigBox& box);

// Per-tool and per-filament settings have one value per tool / material slot
bool is_per_slot(const std::string& key);

// Which tab a setting is on ("print", "filament", "printer"), or "" when it isn't shown
std::string tab_of(const std::string& key);

// Keys whose values differ between two tab_values() results: "key", or "key#i" for one
// tool's or slot's value
std::map<std::string, std::vector<std::string>> modified_keys(const nlohmann::json& now, const nlohmann::json& saved);

} // namespace web
