# Kamp Telsizi 🎙

Arkadaşlarla oyun oynarken (ör. Sons of the Forest) kullanmak için **hafif, düşük gecikmeli sesli sohbet**.

- **Tek exe kurulum**, Windows 10/11
- **Az internet**: Opus ses kodlaması. Kişi başı 12 / 24 / 40 kbps seçilebilir (Normal ayarda saatte ~11 MB)
- **Düşük gecikme**: Ses sunucuya uğramadan doğrudan aranızda gider (P2P / WebRTC)
- **Oyun içinde bas-konuş**: Klavye tuşu ya da fare yan tuşu. Tuş oyundan çalınmaz, oyun da tuşu görmeye devam eder
- Sesle aktif mod (ayarlanabilir eşik), gürültü engelleme, kişi başı ses seviyesi, ping göstergesi
- **Uygulama içinden güncelleme**: Yeni sürüm çıkınca üstte "Güncelle" bandı çıkar, tek tıkla kurulur

## Kurulum (arkadaşlar için)

1. [Releases](https://github.com/m-Emir2133/m-Emir2133.github.io/releases/latest) sayfasından `KampTelsizi_..._x64-setup.exe` dosyasını indir ve çalıştır.
   - Windows "Bilinmeyen yayıncı / SmartScreen" uyarısı verirse **Ek bilgi → Yine de çalıştır** de. Uygulama imzasız olduğu için bu uyarı normal.
2. Adını ve **oda kodunu** yaz. Herkes aynı kodu yazınca birbirinizi duyarsınız.
3. İlk açılışta mikrofon izni sorulursa **İzin ver**.

Kurmak istemeyen tarayıcıdan da girebilir: https://m-emir2133.github.io/ses/ (aynı odaya bağlanır).

## Yeni sürüm yayınlama (Emir için)

1. Değişiklikleri yap (arayüz: `ses/`, Rust kabuğu: `masaustu/`).
2. `masaustu/Cargo.toml` içindeki `version = "1.0.0"` satırını artır (ör. `1.0.1`).
3. `ses/version.json` içindeki sürümü de aynı yap (tarayıcı sürümü için).
4. `main` dalına gönder. GitHub Actions Windows kurulum dosyasını derler ve yeni bir Release yayınlar.
5. Arkadaşların uygulamayı açınca "Yeni sürüm hazır → Şimdi güncelle" bandını görür.

## Yapı

| Klasör | İçerik |
|---|---|
| `ses/` | Arayüz ve ses motoru (HTML/JS, WebRTC + Opus, AudioWorklet ses kapısı). Ayrıca web sürümü olarak yayınlanır |
| `masaustu/` | Rust / Tauri 2 masaüstü kabuğu: global bas-konuş, GitHub'dan güncelleme, NSIS tek exe kurulum |
| `.github/workflows/masaustu.yml` | Windows derlemesi ve otomatik Release |

**Bağlantı:** Kişiler halka açık Nostr sunucuları üzerinden eşleşir, sonra ses doğrudan aranızda akar. Oda kodu şifre olarak da kullanılır. Çok katı ağlarda (bazı mobil hatlar / CGNAT) doğrudan bağlantı kurulamazsa Ayarlar → Gelişmiş'ten bir TURN sunucusu girilebilir.
