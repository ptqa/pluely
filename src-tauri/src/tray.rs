use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let show_hide = MenuItem::with_id(app, "show_hide", "Show/Hide Pluely", true, None::<&str>)?;
    let dashboard = MenuItem::with_id(app, "dashboard", "Open Dashboard", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_hide, &dashboard, &quit])?;
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("default window icon".into()))?;

    TrayIconBuilder::with_id("main")
        .tooltip("Pluely")
        .icon(icon)
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show_hide" => toggle_main_window(app),
            "dashboard" => {
                if let Err(error) = crate::window::show_dashboard_window(app) {
                    eprintln!("Failed to show dashboard from tray: {}", error);
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

fn toggle_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    match window.is_visible() {
        Ok(true) => {
            if let Err(error) = window.hide() {
                eprintln!("Failed to hide main window from tray: {}", error);
            }
        }
        Ok(false) => {
            if let Err(error) = window.show() {
                eprintln!("Failed to show main window from tray: {}", error);
                return;
            }
            if let Err(error) = window.set_focus() {
                eprintln!("Failed to focus main window from tray: {}", error);
            }
        }
        Err(error) => eprintln!("Failed to read main window visibility from tray: {}", error),
    }
}
