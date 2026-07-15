// Uygulama genelinde paylaşılan sabitler (main process + scraper).
module.exports = {
  SESSION_PARTITION: 'persist:akakce-shared',
  // Electron'un varsayılan User-Agent'ındaki " Electron/x.y.z" ekini taşımayan,
  // gerçek bir Chrome tarayıcısına benzeyen User-Agent. Cloudflare'in bot
  // tespitini zorlaştırmak için kullanılır.
  USER_AGENT:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  AKAKCE_ORIGIN: 'https://www.akakce.com',
};
