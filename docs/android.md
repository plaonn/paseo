# Android

## App variants

Controlled by `APP_VARIANT` in `packages/app/app.config.js` (vanilla Expo, no custom Gradle plugin):

| Variant       | App name    | Package ID       |
| ------------- | ----------- | ---------------- |
| `production`  | Paseo       | `sh.paseo`       |
| `development` | Paseo Debug | `sh.paseo.debug` |

EAS profiles: `development`, `production`, and `production-apk` in `packages/app/eas.json`.

`development` uses Android `debug`.

## Fork development policy

Use `plaonn/local` for personal changes and keep `main` aligned with upstream. Build and install the development variant locally on a Mac; it uses the `sh.paseo.debug` package ID and can coexist with the production app.

Do not add a fork-specific GitHub Actions or EAS artifact workflow for iterative development. Keep generated APKs local and untracked, and use the local build commands below.

## Version codes

`packages/app/native-release-version.js` is the single definition of native and F-Droid version-code math. Do not re-derive these numbers anywhere else — a drifted copy produces changelog files that match no published APK, and nothing fails loudly.

The base version code comes from the package version:

```text
major * 1_000_000 + minor * 1_000 + patch
```

Prerelease metadata is ignored, so `0.1.102-beta.1` and `0.1.102` both produce `1102`. The same value is used as the iOS `buildNumber` because `packages/app/eas.json` uses EAS's local app version source. Do not re-enable EAS remote version counters or Android `autoIncrement`; F-Droid and other source-based builders need the native build number to be visible in the repo.

The formula reserves three digits each for minor and patch. If either reaches `1000`, change the formula before cutting that release.

## Prerequisites (local dev)

Local Android builds run on macOS (or Linux) and need the Android toolchain, pinned in `.tool-versions` (`java 21`, `android-sdk 21.0`) and wired up by `.mise.toml` (which derives `ANDROID_HOME` and the command-line tool paths from the `android-sdk` entry). With [mise](https://mise.jdx.dev):

```bash
mise install        # java 21 + android-sdk 21.0 command-line tools
```

> **Pin a real `android-sdk` version, not `latest`.** The mise `android-sdk` plugin's `latest` resolved to the ancient `1.0` bundle, whose `sdkmanager` (3.6.0) predates the `emulator` package and fails with `Failed to find package emulator`. `21.0` ships a current `sdkmanager`. If you bump it, update only the version in `.tool-versions`; `.mise.toml` derives its paths from that tool entry.

`mise install` only lays down the command-line tools. Install the rest and create an emulator. On Apple Silicon:

```bash
sdkmanager --licenses
sdkmanager "platform-tools" "emulator" "platforms;android-35" "build-tools;35.0.0" \
           "system-images;android-35;google_apis;arm64-v8a"
avdmanager create avd -n paseo -k "system-images;android-35;google_apis;arm64-v8a" -d pixel_7
emulator @paseo     # start it; leave running
```

On an Intel Mac, use the `x86_64` system image:

```bash
sdkmanager --licenses
sdkmanager "platform-tools" "emulator" "platforms;android-35" "build-tools;35.0.0" \
           "system-images;android-35;google_apis;x86_64"
avdmanager create avd -n paseo -k "system-images;android-35;google_apis;x86_64" -d pixel_7
emulator @paseo     # start it; leave running
```

Gradle auto-fetches the platform/build-tools it needs once licenses are accepted, so adjust `android-35` only if it asks for a different level.

## Local build + install

From repo root:

```bash
npm run android:development    # Debug build
npm run android:production     # Release build
npm run android:clear          # Remove generated Android project
```

For a production-ID release APK that local Android profiling tools can attach to:

```bash
PASEO_PROFILE_BUILD=1 npm run android:production
```

This keeps the `sh.paseo` package id, release Hermes bundle, and release optimizations. It adds
`<profileable android:shell="true" />` and enables local Android trace markers for workspace mounts
and daemon WebSocket traffic. The markers contain message types and sizes, never payload contents,
and emit only while a system trace records the `sh.paseo` app (`perfetto -a sh.paseo ...`).

Or from `packages/app`:

```bash
# Debug
npx cross-env APP_VARIANT=development expo prebuild --platform android --clean --non-interactive
npx cross-env APP_VARIANT=development expo run:android --variant=debug

# Release
npx cross-env APP_VARIANT=production expo prebuild --platform android --clean --non-interactive
npx cross-env APP_VARIANT=production expo run:android --variant=release

# Clear generated Android project
rm -rf android
```

## Android development loop

For mobile-only changes, connect the local development app to the existing packaged daemon on `6767`. This exercises the app against your existing projects and agents without starting another backend. Do not restart that daemon as part of mobile development. Actions in the development app affect its real data; use isolated state for destructive tests.

Use a physical foldable over wireless ADB for split-screen, pop-up window, folding, keyboard, and live window-resizing acceptance. Use the emulator for basic startup checks and supplementary layouts; emulator success does not establish device-specific multitasking behavior. Both targets use the same Mac-local build, Metro, and `adb reverse` loop. See [wireless ADB](#wireless-adb-on-a-physical-device) for pairing.

If you installed the SDK through Android Studio instead of mise, point the build at that SDK and a JDK 21 installation. For Android Studio's default SDK and Homebrew's JDK 21:

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"
export JAVA_HOME="/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
```

Use your installed JDK path if it differs. For a physical device, skip AVD startup and pair through wireless ADB below. For emulator checks, run `emulator -list-avds`, then start one of the listed names in a separate terminal:

```bash
emulator @<avd-name> -cores 4 -memory 4096
```

The launch options allocate four virtual CPU cores and 4 GiB RAM without changing the saved AVD configuration. A one-core AVD can stall Android system services during startup and bundling.

If the list is empty, create an AVD with the prerequisite commands above, or use Android Studio → Device Manager → Create Virtual Device and select an image matching your Mac's architecture.

Once `adb devices -l` shows your emulator or paired physical device as `device`, select its serial and forward both ports:

```bash
export ANDROID_SERIAL=emulator-5554  # use the serial shown by adb
adb -s "$ANDROID_SERIAL" reverse tcp:8081 tcp:8081
adb -s "$ANDROID_SERIAL" reverse tcp:6767 tcp:6767
adb -s "$ANDROID_SERIAL" reverse --list
```

Keep the existing Paseo daemon running. Run these from the repository root in separate terminals:

```bash
# Metro: start before the native build so Expo reuses this server
EXPO_PUBLIC_LOCAL_DAEMON=localhost:6767 REACT_NATIVE_PACKAGER_HOSTNAME=localhost \
  npm run start:expo --workspace=@getpaseo/app -- --dev-client --localhost --port 8081
```

```bash
# Build and install sh.paseo.debug locally; inherit the SDK/JDK exports above
EXPO_PUBLIC_LOCAL_DAEMON=localhost:6767 REACT_NATIVE_PACKAGER_HOSTNAME=localhost \
  npm run android:development
```

The root `dev:server` and `dev:app` npm scripts explicitly target a separate dev daemon on `6768`; use the commands above for mobile-only work against the existing backend. `EXPO_PUBLIC_LOCAL_DAEMON` is inlined by Metro, so set it on the Metro process itself. Restart Metro with `--clear` when changing the endpoint.

Keep Metro and the daemon running for JS/TS edits and use Fast Refresh. Rebuild after native module or app config changes. When multiple Android targets are connected, pass `--device` to the app workspace build script and select the intended target: `npm run android:development --workspace=@getpaseo/app -- --device`. Reapply both reverse mappings after restarting or reconnecting the Android target. To reopen the installed dev client against this Metro:

```bash
adb -s "$ANDROID_SERIAL" shell am start -a android.intent.action.VIEW \
  -d 'exp+voice-mobile://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081' \
  -p sh.paseo.debug
```

Confirm that the app renders and connects to the intended host. Use app-scoped `adb logcat --pid=<app-pid>` diagnostics (`adb shell pidof sh.paseo.debug`) for startup failures. A Mac health check or a successful Metro bundle alone does not prove that Android executed JS or connected its daemon WebSocket.

### Separate backend for integration or isolated tests

Start a checkout-local daemon only when changing backend/protocol behavior, when the feature requires a newer backend, or when a test needs isolated data:

```bash
PASEO_LISTEN=127.0.0.1:6770 ./scripts/dev-daemon.sh
adb -s "$ANDROID_SERIAL" reverse tcp:6770 tcp:6770
```

Use `EXPO_PUBLIC_LOCAL_DAEMON=localhost:6770` on Metro and the native build, restarting Metro with `--clear` when switching. This daemon uses `.dev/paseo-home`. Do not substitute the existing daemon's state directory. Keep port `6768` free if another application owns it.

### Other transports

The standard AVD host alias `10.0.2.2` also reaches the Mac. Without reverse forwarding, use `REACT_NATIVE_PACKAGER_HOSTNAME=10.0.2.2` and `EXPO_PUBLIC_LOCAL_DAEMON=10.0.2.2:<daemon-port>` on Metro and the build. Use `6767` for the existing backend, `6770` for an isolated backend, or the assigned `$PASEO_SERVICE_DAEMON_PORT` for a Paseo-managed service.

### Wireless ADB on a physical device

For an Android 11+ physical device, enable Developer options → Wireless debugging while the phone and Mac share Wi-Fi. Choose **Pair device with pairing code**, then run `adb pair <phone-ip>:<pairing-port>` and enter the displayed code interactively. Run `adb connect <phone-ip>:<debugging-port>` using the address on the main Wireless debugging screen; this port differs from the pairing port. Select the resulting serial and apply the same two reverse mappings. No USB connection is required. Reconnect and reapply reverse mappings if wireless debugging disconnects.

For foldable UI changes, check the same screen full-screen, in split-screen, and in a pop-up window on the actual device. Resize while the screen is open, show/hide the keyboard, and fold/unfold where supported. Verify that controls remain reachable and drafts, navigation, and the host connection survive the transitions. Record the device and tested modes; do not substitute an emulator-only result.

### Tailscale development without Wi-Fi

Keep app transport independent of ADB. With Tailscale connected on the Mac and phone, forward Metro and the existing daemon privately within the tailnet. Inspect `tailscale serve status` first and preserve unrelated mappings:

```bash
tailscale serve --bg --tcp=18081 tcp://127.0.0.1:8081
tailscale serve --bg --tcp=16767 tcp://127.0.0.1:6767
```

Start Metro from the repo root, replacing `<mac-tailscale-ip>` with the Mac's Tailscale IPv4 address:

```bash
EXPO_OFFLINE=1 \
EXPO_PUBLIC_LOCAL_DAEMON=<mac-tailscale-ip>:16767 \
EXPO_PACKAGER_PROXY_URL=http://<mac-tailscale-ip>:18081 \
REACT_NATIVE_PACKAGER_HOSTNAME=<mac-tailscale-ip> \
  npm run start:expo --workspace=@getpaseo/app -- --dev-client --localhost --port 8081
```

Stop the previous checkout-owned Metro before switching and add `--clear` when changing the daemon endpoint. `EXPO_OFFLINE=1` disables Expo account/network integration, not phone access to Metro; it avoids a non-interactive login prompt during local development. The proxy URL makes the manifest advertise the tailnet bundle address instead of loopback.

On the phone, open `http://<mac-tailscale-ip>:18081/_expo/loading?platform=android` in a browser and choose the development build. Launching the app icon alone can reuse the previous `localhost:8081` server and stall when ADB reverse is unavailable. This path needs neither Wi-Fi nor ADB; mobile data and Tailscale suffice once the development APK is installed.

### Remote ADB over Tailscale

For logs and native UI control without Wi-Fi, enable **USB debugging** in Developer options (no cable required). While a paired wireless ADB connection is available, enable TCP mode:

```bash
adb -s <connected-wireless-serial> tcpip 5555
adb connect <phone-tailscale-ip>:5555
adb -s <phone-tailscale-ip>:5555 shell getprop ro.product.model
```

Then turn Wi-Fi off while keeping mobile data, Tailscale, and USB debugging enabled. Verify ADB commands still work. On the tested SM-F966N, disabling Wi-Fi stopped ADB when USB debugging was off; enabling USB debugging restored TCP access on `5555`. Reboot persistence is unverified: after a reboot, reconnect through wireless debugging and repeat `tcpip` if needed.

TCP mode is not bound exclusively to Tailscale. Keep device authorization enabled and turn TCP mode off when the debugging session ends with `adb -s <phone-tailscale-ip>:5555 usb`; this command does not require attaching a cable. Disconnect the host entry afterward. Do not expose ADB with router port forwarding or Tailscale Funnel.

### Verification and teardown

Check app loading, daemon connectivity, Fast Refresh, and native ADB separately. A Metro bundle response alone does not prove execution. For Fast Refresh, a temporary marker in a mounted component can be observed through the phone's React Native JS debugger, then removed and the file restored. Metro's `/json/list` lists debugger targets; select the exact app and device and inspect only task-relevant state. ADB remains necessary for native logs and UI input, but not for the JS debugger.

This workflow has been exercised on an SM-F966N: tailnet app loading, a code marker reaching the live JS runtime, and ADB commands with Wi-Fi disabled. This does not establish foldable layout acceptance, notification support, reboot persistence, or error-free reloads. Investigate app errors separately from transport success.

At session end, stop only the checkout-owned Metro and any separate dev daemon, disable ADB TCP mode, and remove only the Serve mappings created for this session:

```bash
tailscale serve --tcp=18081 off
tailscale serve --tcp=16767 off
```

Keep the packaged daemon and unrelated services running. The installed development app remains on the phone; start Metro and reopen its development URL for the next session.

## Inverted timeline selection

Android focus and selection visibility requests must not reposition inverted timelines. The
`modules/paseo-scroll` package keeps React Native's scroll manager interface and returns zero for
child-reveal scroll calculations when the vertical scale is inverted. Dragging and explicit scroll
commands still work; non-inverted scroll views keep Android's default behavior.

Register this package before React Native's core package through its Expo config plugin. Normal
Android builds use the prebuilt `react-android` library, so patching Java under `node_modules` does
not change the shipped scroll view. Keep this behavior in the app's compiled native module.

## F-Droid / source-only Android builds

F-Droid builds should set `PASEO_FDROID_BUILD=1` when running Expo prebuild:

```bash
cd packages/app
PASEO_FDROID_BUILD=1 APP_VARIANT=production npx expo prebuild --platform android --clean --non-interactive
cd android
PASEO_FDROID_BUILD=1 ./gradlew assembleRelease --no-daemon --max-workers=1 -Dorg.gradle.parallel=false
```

The flag must be present for both prebuild and Gradle because Gradle starts Metro for the release bundle. Keep the source build serial and daemon-free as shown above: compiling every Expo module can exhaust memory when Gradle workers run in parallel. The profile enables source-built Expo modules, excludes the proprietary camera, Firebase notification, and Expo development-client native modules, disables Gradle dependency metadata, and substitutes JavaScript stubs for camera and notifications. The resulting app supports direct and pasted-link pairing but not QR scanning or push notifications.

For a single-ABI APK, pass React Native's architecture property to Gradle:

```bash
PASEO_FDROID_BUILD=1 ./gradlew assembleRelease \
  -PreactNativeArchitectures=arm64-v8a \
  --no-daemon --max-workers=1 -Dorg.gradle.parallel=false
```

Supported values are `armeabi-v7a`, `arm64-v8a`, `x86`, and `x86_64`. The F-Droid profile filters native libraries to that ABI and changes the APK version code to `baseVersionCode * 10 + abiSuffix`, where the suffixes are ordered `1` through `4` in that same sequence. F-Droid metadata should use four build blocks with `VercodeOperation` entries `10 * %c + 1` through `10 * %c + 4` and pass the matching `reactNativeArchitectures` value in each build command. Builds without a single architecture keep the base version code.

Keep the excluded npm packages installed. Normal builds use them, while the F-Droid profile removes only their Android native modules and config plugins. Paseo always applies `expo-gradle-jvmargs` with `-Xmx4096m` and `-XX:MaxMetaspaceSize=1024m` so local Expo prebuilds have enough Gradle heap whether they use precompiled AARs or source-built Expo modules.

The EAS `production-apk` profile uses the large Android resource class. Release builds compile the native ABIs and run Hermes bundling in the same Gradle invocation; the default worker can exhaust its remaining memory and kill Hermes with exit code 137 even when Gradle's own heap is correctly sized.

### F-Droid store metadata

F-Droid reads the store listing from `fastlane/metadata/android/<locale>/` **at the repo root**. This location provides the best compatibility with the F-Droid release process.

```text
fastlane/metadata/android/
├── en-US/                      (F-Droid fallback locale, mandatory)
│   ├── title.txt               (<=50 chars)
│   ├── short_description.txt   (<=80 chars)
│   ├── full_description.txt    (<=4000 chars, limited HTML)
│   ├── images/
│   │   ├── icon.png            (512x512)
│   │   ├── featureGraphic.png  (1024x500)
│   │   └── phoneScreenshots/   (1.png, 2.png, ...)
│   └── changelogs/             (generated — see below)
├── ja/
└── zh-CN/
```

Locale directories generally match `packages/app/src/i18n/locales.ts`, but note that `en` becomes `en-US`.

F-Droid changelogs are generated from `CHANGELOG.md`. Run `npm run fdroid:changelogs`; `npm run fdroid:changelogs:check` verifies without writing. It is wired into the npm `version` lifecycle, so a release picks it up automatically and `git add -A` stages the result.

One changelog must be generated per-ABI-split, so each version will create **four** identical version-coded entries. F-Droid caps changelogs at 500 characters, so the generator strips some content and adds a link to the full notes.

Stable sync fails loudly if `CHANGELOG.md` has no entry for the version being cut. That is intentional — the release checklist requires the entry to be committed first, so an abort here means the checklist was skipped.

Because the generator runs off the version in `package.json`, it must run **before** the tag is created: fdroidserver only reads metadata from the tag it builds, so the file for version N has to exist in the commit N points at.

Beta releases are an explicit no-op: they do not create or rewrite F-Droid changelog files. Stable releases and promotions generate the four ABI entries from their final changelog.

### React version lockstep

Keep `react` and `react-dom` pinned to the React version embedded by the current `react-native` release. React Native `0.81.x` embeds `react-native-renderer` `19.1.0`, so `packages/app` must use React `19.1.0`. Bumping React to a newer patch can build successfully but crash at JS startup on Android with `Incompatible React versions`, leaving the app on the native splash screen.

## Screenshots

```bash
adb exec-out screencap -p > screenshot.png
```

## Cloud build + submit (EAS)

Stable tag pushes like `v0.1.0` trigger:

- The EAS GitHub app on Expo servers (iOS + Android production builds + store submit). There is no workflow file in this repo for it.
- `.github/workflows/android-apk-release.yml` on GitHub Actions (APK asset on GitHub Release).

iOS auto-submits to App Store review via a Fastlane lane after EAS uploads to TestFlight. Android auto-submits to the Play Store via EAS-managed credentials.

Beta tags like `v0.1.1-beta.1` only trigger the GitHub APK workflow. They publish a GitHub prerelease APK for testing and do not submit to the stores.

`android-v*` tags also trigger only the GitHub APK workflow — useful when you want to ship an APK without going through stores. The GitHub APK workflow supports `workflow_dispatch` with an existing `tag` input so you can rebuild without cutting a new tag.

### Useful commands

```bash
cd packages/app

# Recent builds
npx eas build:list --limit 10 --non-interactive --json | jq '.[] | {platform, status, appVersion, gitCommitHash}'

# Inspect a build (the printed `Logs` URL opens the build's Expo dashboard page,
# which has a Submissions section showing the auto-submit to the Play Store).
npx eas build:view <build-id>
```

The Play Console (Internal testing → Production tracks) is the final confirmation that the binary reached the store.

See [docs/release.md](release.md) for the full mobile-build babysitting flow.
