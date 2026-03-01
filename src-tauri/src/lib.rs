/// Finds the project root by walking up from the executable directory
/// looking for the python-backend/sidecar.py file.
fn find_project_root() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;
    for ancestor in exe_dir.ancestors() {
        let candidate = ancestor.join("python-backend").join("sidecar.py");
        if candidate.is_file() {
            return Some(ancestor.to_path_buf());
        }
    }
    None
}

/// Returns paths needed to spawn the Python sidecar:
/// - `python`: absolute path to the venv Python executable
/// - `backend_dir`: absolute path to python-backend/
/// - `script`: "sidecar.py"
#[tauri::command]
fn get_sidecar_config() -> Result<std::collections::HashMap<String, String>, String> {
    let project_root = find_project_root().ok_or("project root not found")?;
    let backend_dir = project_root.join("python-backend");

    // Find the venv Python — check project root venv first, then python-backend venv
    let venv_python = [
        project_root.join("venv").join("Scripts").join("python.exe"),        // Windows root venv
        project_root.join("venv").join("bin").join("python"),                // Linux/macOS root venv
        backend_dir.join("venv").join("Scripts").join("python.exe"),         // Windows backend venv
        backend_dir.join("venv").join("bin").join("python"),                 // Linux/macOS backend venv
    ]
    .into_iter()
    .find(|p| p.is_file())
    .map(|p| p.to_string_lossy().into_owned());

    let mut config = std::collections::HashMap::new();
    config.insert("backend_dir".into(), backend_dir.to_string_lossy().into_owned());
    config.insert("script".into(), "sidecar.py".into());

    if let Some(python_path) = venv_python {
        config.insert("python".into(), python_path);
    }

    // Pass the current PATH so frontend can prepend venv's Python dir
    if let Ok(path) = std::env::var("PATH") {
        config.insert("system_path".into(), path);
    }

    Ok(config)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![get_sidecar_config])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
