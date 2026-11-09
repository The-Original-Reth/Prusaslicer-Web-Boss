# Prusaslicer - Web Boss.
#
# Compiles PrusaSlicer BOSS 3.0 from source, using its own static dependency build, and
# links our engine (engine/) against BOSS's service layer, inside BOSS's source tree, the
# way BOSS builds its own command-line slicer. The final image runs the gateway (gateway/),
# which serves the web page (web/) and starts one engine per open project.
#
# BOSS is pinned to one of its nightly builds that has been tried with this code. To move to
# a newer nightly: build with --build-arg SLICER_COMMIT=<the nightly's commit>, test it,
# then change the default below. BOSS's dependencies are rebuilt only when a new commit
# changes them (deps/, cmake/).

ARG SLICER_OWNER_REPO=mjonuschat/PrusaSlicer
# BOSS's nightly of 2026-11-07
ARG SLICER_COMMIT=6e7f494fa335a7b91e07a1589697c52818386b22

########## the build tools ##########
# BOSS 3.0 is C++20 and built with a current GCC (its Linux build uses the GNOME 50 SDK);
# Debian trixie has GCC 14 and CMake 3.31
FROM debian:trixie AS toolchain

RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates git build-essential autoconf automake libtool cmake ninja-build \
        pkg-config texinfo wget file m4 python3 nasm \
        libglu1-mesa-dev libgl1-mesa-dev libegl-dev libgtk-3-dev libdbus-1-dev \
        libwebkit2gtk-4.1-dev libsecret-1-dev \
        libx11-dev libxext-dev libxrandr-dev libxinerama-dev libxcursor-dev libxi-dev \
        libxkbcommon-dev libwayland-dev wayland-protocols libudev-dev && \
    rm -rf /var/lib/apt/lists/*

# Some dependency archives have non-ASCII file names; CMake can't unpack them under
# the default POSIX locale. C.UTF-8 is built into Debian, no locales package needed.
ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

########## BOSS's source ##########
FROM toolchain AS source
ARG SLICER_OWNER_REPO
ARG SLICER_COMMIT
# Just that commit; the history isn't needed, and dropping .git keeps the layers below
# depending on the source alone
RUN git init -q /src && \
    git -C /src fetch -q --depth 1 "https://github.com/${SLICER_OWNER_REPO}" "${SLICER_COMMIT}" && \
    git -C /src checkout -q FETCH_HEAD && \
    git -C /src log -1 --format='%H %cs' > /src/.source-commit && \
    rm -rf /src/.git

########## BOSS's dependencies ##########
# Boost, CGAL, OpenVDB, TBB, wxWidgets, ... built statically. The slow part (an hour or
# more). Only deps/ and cmake/ are copied in, so a new nightly that leaves them alone
# reuses this layer. Only the installed result (destdir) is kept: the build trees are
# many GB, and a layer that big gets evicted from Docker's build cache.
FROM toolchain AS deps
# Parallel compile jobs. Each job can use ~2GB RAM while linking; lower this on
# small servers.
ARG BUILD_JOBS=4
COPY --from=source /src/deps /src/deps
COPY --from=source /src/cmake /src/cmake
WORKDIR /src/deps/build
# Sentry (crash reporting) is left out, as in BOSS's own Linux build
RUN cmake .. -DPrusaSlicer_deps_PACKAGE_EXCLUDES=sentry -DDESTDIR=/src/deps/build/destdir && \
    cmake --build . --parallel "${BUILD_JOBS}" && \
    find . -mindepth 1 -maxdepth 1 ! -name destdir -exec rm -rf {} +

########## BOSS's libraries ##########
FROM deps AS build
ARG BUILD_JOBS=4
# BOSS's desktop target looks for HID support (3D mice) when it's configured; installed here
# rather than with the tools, so the dependency build above stays cached
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends libhidapi-dev && \
    rm -rf /var/lib/apt/lists/*
COPY --from=source /src /src-new
RUN cp -a /src-new/. /src/ && rm -rf /src-new

# The engine joins BOSS's source tree as one more target next to BOSS's own CLI, whose
# library (slic3r-app-cli: BOSS's service layer, as its command-line slicer drives it)
# it links. 3.0 only builds with its GUI libraries (src/CMakeLists.txt refuses
# otherwise), so they're built too, but nothing opens a window. The libraries are built
# here, before the engine's source is copied in, so changing the engine only recompiles
# the engine.
RUN echo 'if(EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/web-engine)\n  add_subdirectory(web-engine)\nendif()' \
        >> /src/src/CMakeLists.txt
WORKDIR /src
RUN cmake --preset linux-x86_64 -DSLIC3R_BUILD_TESTS=OFF -DSLIC3R_SENTRY_DSN= && \
    cmake --build build --target slic3r-app-cli --parallel "${BUILD_JOBS}"

########## the engine ##########
FROM build AS engine-build
ARG BUILD_JOBS=4
COPY engine /src/src/web-engine
RUN cmake --preset linux-x86_64 -DSLIC3R_BUILD_TESTS=OFF -DSLIC3R_SENTRY_DSN= && \
    cmake --build build --target prusaslicer-web-engine --parallel "${BUILD_JOBS}" && \
    install -D build/src/web-engine/prusaslicer-web-engine /opt/engine/bin/prusaslicer-web-engine && \
    cp /src/.source-commit /opt/engine/SOURCE && \
    cp -r /src/resources /opt/engine/resources

########## the web page ##########
FROM node:22-bookworm-slim AS web-build
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web ./
RUN npm run build

########## the engine alone (for engine tests) ##########
FROM debian:trixie-slim AS engine

ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# BOSS's own libraries are linked statically; the system ones its GUI layer brings along
# (GTK, OpenGL, WebKit) come from Debian, though the engine never opens a window
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        libgtk-3-0t64 libwebkit2gtk-4.1-0 libglu1-mesa libgl1 libegl1 libsecret-1-0 \
        libdbus-1-3 libudev1 libxkbcommon0 libpng16-16t64 libhidapi-libusb0 ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# The engine, plus the presets, shapes and G-code templates it reads at run time (BOSS
# looks for them in ../resources next to its program)
COPY --from=engine-build /opt/engine /opt/engine

# One project per process; JSON commands on stdin, events on stdout (see engine/src/main.cpp)
ENTRYPOINT ["/opt/engine/bin/prusaslicer-web-engine"]

########## the app: gateway + web page + engine ##########
FROM engine AS app

RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 python3-venv && \
    rm -rf /var/lib/apt/lists/*

COPY gateway/requirements.txt /opt/gateway/requirements.txt
RUN python3 -m venv /opt/gateway/venv && \
    /opt/gateway/venv/bin/pip install --no-cache-dir -r /opt/gateway/requirements.txt

COPY gateway /opt/gateway
COPY --from=web-build /web/dist /opt/web

ENV ENGINE_BIN=/opt/engine/bin/prusaslicer-web-engine \
    WEB_DIR=/opt/web \
    DATA_DIR=/data
VOLUME /data
EXPOSE 8080
WORKDIR /opt/gateway
ENTRYPOINT []
CMD ["/opt/gateway/venv/bin/uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080"]
