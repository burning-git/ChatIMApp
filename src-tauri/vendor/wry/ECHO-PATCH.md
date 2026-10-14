# Echo's Wry file-picker patch

Base: the unmodified crates.io `wry` 0.57.0 release. Upstream MIT and Apache-2.0 license files are retained.

On macOS, `+[NSOpenPanel openPanel]` can return nil if the application's bundle has been replaced while running, or the AppKit panel service is temporarily unavailable. The typed objc2 factory assumes a non-null result and panics inside the Objective-C WebKit delegate, aborting the entire application.

This patch uses the nullable Objective-C return type from upstream [Wry PR #1881](https://github.com/tauri-apps/wry/pull/1881) and [PR #1716](https://github.com/tauri-apps/wry/pull/1716). A missing panel completes the upload request as cancelled. An unexpected non-main-thread callback is cancelled too. Normal selection, multi-selection and cancellation keep their existing behavior. Windows code is untouched.

Echo adds two regression tests around the cancellation boundary. The application's test suite includes this exact source file, so the tests do not need Wry's unrelated example/GPU development dependencies. Run from the application's Cargo manifest:

```sh
cargo test --locked --manifest-path src-tauri/Cargo.toml file_picker_regressions
```

Once a compatible published Wry release includes this fix, remove `[patch.crates-io]` and this vendor directory and update the application lockfile. Do not patch Cargo's global registry cache.
