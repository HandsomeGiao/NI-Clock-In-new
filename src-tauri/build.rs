fn main() {
    let target = std::env::var("TARGET").expect("Cargo must provide the build target");
    assert_eq!(
        target, "x86_64-pc-windows-msvc",
        "NI Clock In supports Windows 11 x64 only; use x86_64-pc-windows-msvc"
    );
    tauri_build::build()
}
