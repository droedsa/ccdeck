// Без консольного окна в release-сборке на Windows
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Копия приложения под именем ccdeck-wrap — обёртка для расширения VS Code
    if ccdeck_lib::wrap::is_wrapper_invocation() {
        ccdeck_lib::wrap::main();
    }
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("--dump") => ccdeck_lib::dump(args.get(2).cloned()),
        Some("--wrap") => {
            // отладка: ccdeck --wrap <claude> <args…>
            ccdeck_lib::wrap::main_from(args[2..].to_vec())
        }
        _ => ccdeck_lib::run(),
    }
}
