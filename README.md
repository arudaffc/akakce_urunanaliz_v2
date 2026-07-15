# Akakçe Ürün Analiz

Akakçe.com arama sonuçlarını tarayan, aranan ürünün hangi sırada çıktığını, yakınlık
skorunu ve satıcı/fiyat bilgilerini gösteren Electron masaüstü uygulaması.

## Kurulum

```bash
npm install
```

## Çalıştırma

```bash
npm start
```

> Aynı anda birden fazla `npm start` çalıştırmayın; Chromium önbellek çakışmasına yol açabilir.

## Özellikler

### Tek Ürün Tarama

- Arama terimi girilir, Akakçe sonuçları listelenir.
- Her sonuç için **yakınlık rozeti** (başlık ve gerektiğinde detay içeriği).
- Başlıkta eşleşen kelimeler vurgulanır (`<mark>`).
- Sağ panelde satıcı listesi ve fiyatlar (tek teklifli ve çok satıcılı ürünler dahil).
- **Detay** ile ürün sayfası uygulama içi gömülü tarayıcıda açılır.
- Araç çubuğu: sıralama, yakınlık filtresi, yalnızca çok satıcılı filtre, **Excel dışa aktarma**.
- Tarama kontrolü: **Durdur / Devam Et / İptal Et** (satıcı taraması sırasında).
- Düşük yakınlıkta detay taramasını atlama (eşik ayarlardan yapılandırılır).
- Her yeni aramada filtreler varsayılan değerlere döner.

### Çoklu Ürün Tarama

- `.txt` / `.csv` dosyasından terim listesi yüklenir.
- Her terim için ayrı sonuç bölümü ve satıcı tablosu.
- Üstte **özet tablo** (terim, en iyi eşleşme, sıra, yakınlık, fiyat, satıcı, durum).
- İlerleme çubuğu, ETA ve Durdur / Devam Et / İptal Et.
- Toplu **Excel dışa aktarma**.

### Ayarlar

Sol menüden **Ayarlar** sayfası:

| Ayar | Varsayılan | Açıklama |
|------|------------|----------|
| Taranacak ürün sayısı | 10 | Her aramada işlenecek maksimum sonuç (1–40) |
| Satıcılar sayısı | 5 | Listede ve Excel'de gösterilecek satıcı (1–30) |
| Düşük yakınlıkta detay atlama | %50 | Başlık yakınlığı bu değerin altındaysa detay taraması yapılmaz |
| Varsayılan sıralama | Akakçe sırası | Her yeni aramada uygulanan sıralama |

Ayarlar `localStorage` ile kalıcıdır.

## Mimari

| Dosya | Görev |
|-------|--------|
| `main.js` | Ana süreç: pencere, `BrowserView`, IPC, Excel dışa aktarma |
| `preload.js` | `window.akakceAPI` köprüsü |
| `scraper.js` | Gizli Chromium penceresi ile arama/satıcı verisi çekme |
| `constants.js` | Oturum, user-agent, origin sabitleri |
| `renderer/` | Arayüz (HTML / CSS / vanilla JS) |

### Veri kaynağı

Satıcı ve ürün bilgisi öncelikle Akakçe sayfalarına gömülü **Astro island JSON**
verisinden okunur (`initialPgList`, `spotPg`, arama `productList`). DOM seçicileri
yedek stratejidir. Tek teklifli ürünlerde satıcı adı arama kartının DOM'undan
(`kargo` sonrası metin, mağaza butonları, bilinen satıcı kimlikleri) tamamlanır.

## Cloudflare

Uygulama gerçek Chromium motoru ve kalıcı oturum (`persist:akakce-shared`) kullanır.
Cloudflare ek doğrulama isterse arayüzde uyarı gösterilir; scraper otomatik yeniden
dener (en fazla 2 kez).

Akakçe HTML/JSON yapısı değişirse `scraper.js` içindeki `EXTRACT_SEARCH_RESULTS_JS`
ve `EXTRACT_SELLERS_JS` betiklerinin güncellenmesi gerekebilir.

## Geliştirme notları

- Paketleme (`.exe`) henüz yapılandırılmamıştır; çalıştırma `npm start` ile yapılır.
- Bağımlılıklar: `electron`, `xlsx`.

## Lisans

`UNLICENSED` — özel kullanım.
