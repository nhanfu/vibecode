//! VIBE CODE — the native side: terminals, files, git, Claude's session store, SQL Server,
//! the built-in browser and the MCP server that lets each chat's Claude drive them.

pub mod core;
pub mod secure;

mod appcmds;
mod browser;
mod fsx;
mod git;
mod keybindings;
mod plugins;
mod mcp;
mod mssql;
mod pty;
mod sessions;
mod settings;
mod userdb;
mod webdata;
mod windowing;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    core::fix_mac_path();

    tauri::Builder::default()
        // one instance: launching it again toggles the running window (Guake-style)
        .plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| windowing::toggle()))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec![windowing::HIDDEN_ARG])))
        .invoke_handler(tauri::generate_handler![
            // terminals + coding agents
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_kill_all,
            pty::pty_visible,
            pty::claude_detect,
            pty::agents_detect,
            appcmds::claude_usage,
            appcmds::sys_memory,
            appcmds::claude_get_project_bypass,
            keybindings::keybindings_path,
            keybindings::keybindings_read,
            appcmds::claude_set_project_bypass,
            // built-in browser
            browser::web_open,
            browser::web_place,
            browser::web_set_active,
            browser::web_navigate,
            browser::web_history,
            browser::web_reload,
            browser::web_stop,
            browser::web_set_user_agent,
            browser::web_set_dark,
            browser::web_close,
            browser::web_focus,
            webdata::web_data,
            webdata::web_import_chrome,
            webdata::web_suggest,
            webdata::web_visit,
            webdata::web_title,
            // Claude session store
            sessions::sessions_list,
            sessions::sessions_images,
            sessions::sessions_context,
            sessions::sessions_tasks,
            sessions::sessions_subagents,
            sessions::sessions_changes,
            plugins::plugin_list,
            plugins::plugin_start,
            plugins::plugin_settings_file,
            plugins::plugin_stop,
            plugins::plugin_restart,
            plugins::plugin_set,
            plugins::plugin_logs,
            plugins::plugin_install,
            plugins::plugin_uninstall,
            plugins::plugin_registry,
            plugins::plugin_registry_url,
            // SQL Server
            mssql::db_list,
            mssql::db_get,
            mssql::db_save,
            mssql::db_save_many,
            mssql::db_remove,
            mssql::db_test,
            mssql::db_build_conn,
            mssql::db_parse_conn,
            mssql::db_query,
            mssql::db_cancel,
            mssql::db_databases,
            mssql::db_objects,
            mssql::db_columns,
            mssql::db_scan_project,
            mssql::db_scan_ssms,
            // window
            windowing::win_state,
            windowing::win_minimize,
            windowing::win_badge,
            windowing::win_toggle_maximize,
            windowing::win_close,
            windowing::win_hide,
            windowing::win_set_mode,
            // files + git
            fsx::fs_read_dir,
            fsx::fs_read_file,
            fsx::fs_write_file,
            fsx::fs_list_files,
            fsx::fs_watch,
            fsx::fs_reveal,
            fsx::fs_open_path,
            git::git_state,
            git::git_original,
            git::git_init,
            git::git_show,
            git::git_snapshot,
            git::git_log,
            git::git_commit_files,
            git::git_branches,
            git::git_checkout,
            // app
            userdb::userdb_snapshot,
            userdb::userdb_prefs_write,
            userdb::userdb_save,
            appcmds::app_settings,
            appcmds::app_remember_folder,
            appcmds::app_set_settings,
            appcmds::app_pick_folder,
            appcmds::app_pick_files,
            appcmds::app_file_info,
            appcmds::app_open_external,
            appcmds::app_clear_browser_cache,
            appcmds::app_relaunch,
            appcmds::app_save_image,
            appcmds::app_clipboard_files,
            appcmds::app_clipboard_image,
        ])
        .setup(|app| {
            core::init(app.handle());
            // before any chat starts: chats get the MCP server's address at launch
            tauri::async_runtime::block_on(mcp::start())?;
            plugins::warm_up();
            windowing::init(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == core::MAIN {
                windowing::on_event(window, event);
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building VIBE CODE")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                pty::kill_all();
                userdb::checkpoint();
                mssql::cancel_all();
                plugins::stop_all();
                let _ = app.get_webview_window(core::MAIN);
            }
        });
}
