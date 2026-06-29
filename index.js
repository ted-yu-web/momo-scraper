const express = require('express');
const puppeteer = require('puppeteer');
const cron = require('node-cron');

const app = express();
app.use(express.json());

const MOMO_URL = 'https://www.momoshop.com.tw/edm/cmmedm.jsp?lpn=O1K5FBOqsvN&n=1';
const KEYWORDS = ['ARIEL','Persil','橘子工坊','白蘭','一匙靈','白鴿','洗衣精','洗衣球','洗衣凝露','洗衣膠囊','泡舒','白熊','Pril','茶樹莊園','妙管家'];
const SHEET_ID = '16tCugCdemwOznXfYN6P0WEXZyoh8Hd4v1iAYPwKfEBA';
const SHEET_NAME = '競品觀察';
const TRACK_SHEET = '追蹤清單';

app.get('/', (req, res) => {
  res.send('momo 爬蟲服務運行中 ✅');
});

async function scrape() {
  console.log('開始執行爬取：' + new Date().toLocaleString('zh-TW'));
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    await page.setViewport({ width: 1280, height: 800 });
    
    await page.goto(MOMO_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    
    // 滾動載入所有商品
    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await new Promise(r => setTimeout(r, 1500));
    }
    await new Promise(r => setTimeout(r, 3000));

    // 抓取所有時段的符合商品
    const matched = await page.evaluate((keywords) => {
      const results = [];
      const items = document.querySelectorAll('li.box1');
      
      items.forEach(li => {
        const text = li.innerText;
        const link = li.querySelector('a[href*="GoodsDetail"]');
        if (!link) return;
        
        const hit = keywords.some(k => text.includes(k));
        if (!hit) return;
        
        const iCode = (link.href.match(/i_code=(\d+)/) || [])[1];
        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
        const prices = lines
          .filter(l => /^\$[\d,]+$/.test(l))
          .map(l => parseInt(l.replace(/[$,]/g, '')));
        const discount = lines.find(l => /^\d+折$/.test(l)) || '';
        const remaining = lines.find(l => l.includes('倒數')) || '';
        
        // 找所屬時段（從父層往上找時段標題）
        let slot = '';
        let el = li.parentElement;
        while (el) {
          const title = el.querySelector('[class*="time"], [class*="Time"], h2, h3');
          if (title) {
            const m = title.innerText.match(/(\d{1,2}:\d{2})/);
            if (m) { slot = m[1]; break; }
          }
          el = el.parentElement;
        }
        
        results.push({
          iCode,
          brand: lines[0] || '',
          name: lines[1] || lines[0] || '',
          discount,
          salePrice: prices.length ? Math.min(...prices) : 0,
          remaining,
          slot,
          url: link.href
        });
      });
      return results;
    }, KEYWORDS);

    console.log('找到符合商品：' + matched.length + ' 個');

    // 逐一抓取詳細資訊
    const now = new Date();
    const yearMonth = `${now.getFullYear()}/${now.getMonth() + 1}`;
    const date = `${now.getMonth() + 1}月${now.getDate()}日`;
    const rows = [];

    for (const item of matched) {
      try {
        const detailPage = await browser.newPage();
        await detailPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
        await detailPage.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        const detail = await detailPage.evaluate(() => {
          const title = document.title
            .replace(/-momo購物網.*/,'')
            .replace(/\s*-\s*好評推薦.*/,'')
            .trim();
          const plain = document.body.innerText;
          const giftM = plain.match(/(?:下單贈|下單送|買就送|獨家[^送\n]{0,5}送|加贈)[^\n。]{3,40}/g) || [];
          const gift = giftM.filter(x => x.length < 50).slice(0, 2).join(' | ');
          const slotM = plain.match(/本檔時段\s*(\d{1,2}:\d{2})\s*開搶/);
          const slot = slotM ? slotM[1] : null;
          return { fullName: title, gift, slot };
        });

        await detailPage.close();

        // ml 規格
        let mlNum = '';
        const mlMulti = detail.fullName.match(/(\d+)\s*(?:ml|ML|g(?!\w))\s*[xX×]\s*(\d+)/i);
        if (mlMulti) {
          mlNum = parseInt(mlMulti[1]) * parseInt(mlMulti[2]);
        } else {
          const mlSingle = detail.fullName.match(/(\d+)\s*(ml|ML|g(?!\w)|kg|KG)/i);
          if (mlSingle) mlNum = parseInt(mlSingle[1]) * (mlSingle[2].toLowerCase() === 'kg' ? 1000 : 1);
        }

        const pricePerMl = (mlNum && item.salePrice) ? (item.salePrice / mlNum).toFixed(2) : '';
        const slot = detail.slot || item.slot || now.getHours() + ':00';
        const cat = /膠囊|洗衣球/.test(detail.fullName) ? '洗衣膠囊' :
                    /洗衣凝露/.test(detail.fullName) ? '洗衣凝露' :
                    /洗碗|碗盤/.test(detail.fullName) ? '洗碗精' : '洗衣精';

        rows.push({
          iCode: item.iCode,
          data: [yearMonth, date, slot, 'momo', '限搶',
                 item.brand, detail.fullName, item.salePrice,
                 mlNum || '', pricePerMl, cat, detail.gift]
        });

        await new Promise(r => setTimeout(r, 500));
      } catch(e) {
        console.error('商品失敗 ' + item.iCode + ': ' + e.message);
      }
    }

    await browser.close();

    // 寫入 Google Sheet（透過 Apps Script Web App）
    if (rows.length > 0 && process.env.WEBAPP_URL) {
      try {
        const axios = require('axios');
        await axios.post(process.env.WEBAPP_URL + '/write', {
          rows: rows.map(r => r.data),
          trackRows: rows.map(r => ({
            iCode: r.iCode,
            brand: r.data[5],
            category: r.data[10],
            name: r.data[6]
          }))
        });
        console.log('寫入完成：' + rows.length + ' 筆');
      } catch(e) {
        console.error('寫入失敗：' + e.message);
      }
    }

    return rows;

  } catch(e) {
    await browser.close();
    console.error('爬取失敗：' + e.message);
    throw e;
  }
}

// 手動觸發 API
app.get('/scrape', async (req, res) => {
  try {
    const rows = await scrape();
    res.json({ success: true, count: rows.length });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 每天 10:30 & 18:00 自動執行（台灣時間 = UTC+8）
cron.schedule('30 2 * * *', () => scrape()); // UTC 02:30 = 台灣 10:30
cron.schedule('0 10 * * *', () => scrape()); // UTC 10:00 = 台灣 18:00

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
});
