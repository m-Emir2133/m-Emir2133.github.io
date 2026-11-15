// Kamp Telsizi — masaüstü kabuğu.
// Arayüz ve ses (WebRTC/Opus) ../ses klasöründeki web uygulamasıdır; bu dosya şunları ekler:
//  * Oyun penceresi öndeyken de çalışan bas-konuş tuşu (Windows, GetAsyncKeyState — tuşu oyundan çalmaz)
//  * GitHub Releases üzerinden uygulama içi güncelleme
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::sync::atomic::{AtomicU32, Ordering};

/// Güncellemelerin alındığı depo (Releases sayfası).
const REPO: &str = "m-Emir2133/m-Emir2133.github.io";
const UA: &str = concat!("kamp-telsizi/", env!("CARGO_PKG_VERSION"));

/// Takip edilen bas-konuş tuşunun Windows sanal tuş kodu (0 = kapalı).
static PTT_VK: AtomicU32 = AtomicU32::new(0);

#[derive(Serialize)]
struct AppInfo {
    version: &'static str,
    global_ptt: bool,
}

#[derive(Serialize)]
struct UpdateInfo {
    version: String,
    url: String,
    notes: String,
}

#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo { version: env!("CARGO_PKG_VERSION"), global_ptt: cfg!(windows) }
}

#[tauri::command]
fn set_ptt_key(vk: u32) {
    PTT_VK.store(vk, Ordering::Relaxed);
}

/// Windows'un kendi TLS katmanını kullanan HTTP istemcisi (ek C kütüphanesi yok, küçük exe).
fn http() -> ureq::Agent {
    use ureq::tls::{TlsConfig, TlsProvider};
    ureq::Agent::config_builder()
        .tls_config(TlsConfig::builder().provider(TlsProvider::NativeTls).build())
        .build()
        .into()
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// "1.2.10" > "1.2.9" gibi sayısal karşılaştırma.
fn is_newer(remote: &str, local: &str) -> bool {
    let parse = |s: &str| -> Vec<u64> {
        s.split(|c: char| c == '.' || c == '-')
            .map(|p| p.parse().unwrap_or(0))
            .take(3)
            .collect()
    };
    parse(remote) > parse(local)
}

fn fetch_latest() -> Result<Option<UpdateInfo>, String> {
    let url = format!("https://api.github.com/repos/{REPO}/releases/latest");
    let mut res = http().get(&url)
        .header("User-Agent", UA)
        .header("Accept", "application/vnd.github+json")
        .call()
        .map_err(err)?;
    let v: serde_json::Value = res.body_mut().read_json().map_err(err)?;
    let tag = v["tag_name"].as_str().unwrap_or_default();
    let version = tag.rsplit('v').next().unwrap_or(tag).to_string();
    if version.is_empty() || !is_newer(&version, env!("CARGO_PKG_VERSION")) {
        return Ok(None);
    }
    let asset = v["assets"].as_array().and_then(|list| {
        list.iter().find(|a| {
            a["name"].as_str().is_some_and(|n| n.to_ascii_lowercase().ends_with("-setup.exe"))
        })
    });
    let Some(asset) = asset else { return Ok(None) };
    Ok(Some(UpdateInfo {
        version,
        url: asset["browser_download_url"].as_str().unwrap_or_default().to_string(),
        notes: v["body"].as_str().unwrap_or_default().chars().take(500).collect(),
    }))
}

#[tauri::command]
async fn check_update() -> Result<Option<UpdateInfo>, String> {
    tauri::async_runtime::spawn_blocking(fetch_latest).await.map_err(err)?
}

/// Kurulum dosyasını indirir, sessiz modda çalıştırır ve uygulamayı kapatır.
/// Kurulum bitince uygulama kendiliğinden yeniden açılır (/R).
#[tauri::command]
async fn install_update(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if !url.starts_with("https://github.com/") {
        return Err("Geçersiz indirme adresi".into());
    }
    let path = tauri::async_runtime::spawn_blocking(move || -> Result<std::path::PathBuf, String> {
        let res = http().get(&url).header("User-Agent", UA).call().map_err(err)?;
        let path = std::env::temp_dir().join("KampTelsizi-guncelleme-setup.exe");
        let mut file = std::fs::File::create(&path).map_err(err)?;
        std::io::copy(&mut res.into_body().into_reader(), &mut file).map_err(err)?;
        Ok(path)
    })
    .await
    .map_err(err)??;

    std::process::Command::new(&path)
        .args(["/P", "/R", "/UPDATE"])
        .spawn()
        .map_err(err)?;
    app.exit(0);
    Ok(())
}

#[cfg(windows)]
fn start_ptt_watcher(app: tauri::AppHandle) {
    use tauri::Emitter;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    std::thread::spawn(move || {
        let mut last = false;
        loop {
            let vk = PTT_VK.load(Ordering::Relaxed);
            // En yüksek bit = tuş şu an basılı
            let down = vk != 0 && (unsafe { GetAsyncKeyState(vk as i32) } as u16 & 0x8000) != 0;
            if down != last {
                last = down;
                let _ = app.emit("ptt", down);
            }
            std::thread::sleep(std::time::Duration::from_millis(if vk == 0 { 100 } else { 8 }));
        }
    });
}

fn main() {
    tauri::Builder::default()
        .setup(|_app| {
            #[cfg(windows)]
            start_ptt_watcher(_app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![app_info, set_ptt_key, check_update, install_update])
        .run(tauri::generate_context!())
        .expect("Kamp Telsizi başlatılamadı");
}
