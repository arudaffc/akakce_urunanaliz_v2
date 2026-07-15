# Akakçe Ürün Analiz

Akakçe.com arama sonuçlarını tarayan, aranan ürünün sıralanıp sıralanmadığını,
hangi başka ürün ve satıcıların çıktığını gösteren bir Electron masaüstü
uygulaması.

## Kurulum

```bash
npm install
```

## Çalıştırma

```bash
npm start
```

## Özellikler

- **Sol menü / sağ içerik** düzeni: *Tek Ürün Tarama* ve *Çoklu Ürün Tarama*.
- **Tek Ürün Tarama**: "Aranan Değer" girilir, `akakce.com/arama/?q=...`
  sonuçları listelenir. İlk sonuç aranan değerle eşleşiyorsa "Eşleşti" rozeti
  gösterilir; diğer ürünler ve bulundukları satıcı sayısı da listelenir.
- Her sonucun **sağında**, o ürünün satıcı listesi ("1. Satıcı", "2. Satıcı",
  ...) ayrı bir ürün detay taramasıyla otomatik olarak doldurulur.
- **Detay** butonuna basıldığında gerçek akakce.com sayfası, uygulama
  içinde gömülü bir tarayıcı panelinde ("Sonuçlara Dön" ile geri dönülebilir)
  açılır — harici bir tarayıcıya çıkılmaz.
- **Çoklu Ürün Tarama**: `.txt`/`.csv` dosyasından (satır satır ya da ilk
  sütun) birden çok arama terimi içe aktarılır, sırayla taranır ve her terim
  için Tek Ürün Tarama ile aynı detaylı sonuç + satıcı tablosu bir bölüm
  (accordion) altında gösterilir.
- Koyu tema, tüm pencere (özel başlık çubuğu dahil) için tutarlı uygulanır.

## Mimari

- `main.js` — Electron ana süreç: pencere/`BrowserView` yönetimi, IPC uçları.
- `preload.js` — Renderer'a güvenli `window.akakceAPI` köprüsü.
- `scraper.js` — Gizli bir `BrowserWindow` (gerçek Chromium motoru) ile
  Cloudflare doğrulamasını bekleyip akakce.com arama/ürün detay sayfalarını
  DOM üzerinden okuyan modül.
- `renderer/` — Arayüz (HTML/CSS/JS, framework yok).

## Cloudflare Notu

Uygulama, akakce.com'un Cloudflare korumasını gerçek bir Chromium motoruyla
(sıradan bir tarayıcı gibi JS çalıştırarak) ve kalıcı bir oturum (`cf_clearance`
çerezinin saklandığı `persist:akakce-shared` partition'ı) kullanarak aşmaya
çalışır. Bu %100 garanti değildir; Cloudflare ek doğrulama isterse arayüzde
"Cloudflare doğrulaması geçilemedi" uyarısı gösterilir ve tekrar denenebilir.

Akakçe'nin HTML yapısı değişirse `scraper.js` içindeki `EXTRACT_SEARCH_RESULTS_JS`
ve `EXTRACT_SELLERS_JS` seçicilerinin güncel sayfa yapısına göre güncellenmesi
gerekebilir.
