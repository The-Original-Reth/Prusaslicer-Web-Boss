# Built inside BOSS's source tree: the Dockerfile copies this folder to src/web-engine and adds
# it to src/CMakeLists.txt, so it links the same library as BOSS's own command-line slicer
# (slic3r-app-cli: BOSS's service layer, with the CLI's helpers).
find_package(nlohmann_json REQUIRED)

add_executable(prusaslicer-web-engine src/main.cpp src/settings.cpp)
target_link_libraries(prusaslicer-web-engine PRIVATE slic3r-app-cli nlohmann_json::nlohmann_json)
