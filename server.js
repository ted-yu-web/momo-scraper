const express = require('express');
const { runScraper } = require('./index');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// 健康檢查（Render 需要）
app.get('/', (req, res) => {
  res.send('momo scraper is running');
});

// 觸發爬蟲的端點
app.get('/scrape', async (req, res) => {
  const secret = req.query.secret;
  if (secret !== process.env.SECRET_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log('Scrape triggered at', new Date().toISOString());
  
  try {
    res.json({ status: 'started', message: '爬蟲已啟動，結果將寫入 Google Sheet' });
    await runScraper();
    console.log('Scrape completed');
  } catch (err) {
    console.error('Scrape error:', err);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
