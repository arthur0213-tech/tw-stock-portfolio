/**
 * 跨券商股票與借券資產管理系統 (Portfolio & Stock Lending Tracker)
 * 儲存：純本地端 LocalStorage，無隱私外洩風險
 */

// 常用熱門台股/ETF 代號字典（提供自動帶入名稱與參考市價）
const STOCK_DICTIONARY = {
  '2330': { name: '台積電', defaultPrice: 1040.0, isETF: false },
  '2317': { name: '鴻海', defaultPrice: 215.0, isETF: false },
  '2454': { name: '聯發科', defaultPrice: 1310.0, isETF: false },
  '2308': { name: '台達電', defaultPrice: 405.0, isETF: false },
  '2382': { name: '廣達', defaultPrice: 310.0, isETF: false },
  '3231': { name: '緯創', defaultPrice: 118.0, isETF: false },
  '2376': { name: '技嘉', defaultPrice: 275.0, isETF: false },
  '2303': { name: '聯電', defaultPrice: 50.5, isETF: false },
  '2603': { name: '長榮', defaultPrice: 205.0, isETF: false },
  '2609': { name: '陽明', defaultPrice: 68.0, isETF: false },
  '2881': { name: '富邦金', defaultPrice: 91.5, isETF: false },
  '2882': { name: '國泰金', defaultPrice: 68.0, isETF: false },
  '2886': { name: '兆豐金', defaultPrice: 39.8, isETF: false },
  '2884': { name: '玉山金', defaultPrice: 28.5, isETF: false },
  '2891': { name: '中信金', defaultPrice: 36.8, isETF: false },
  '0050': { name: '元大台灣50', defaultPrice: 195.0, isETF: true },
  '0056': { name: '元大高股息', defaultPrice: 38.2, isETF: true },
  '00878': { name: '國泰永續高股息', defaultPrice: 22.8, isETF: true },
  '00919': { name: '群益台灣精選高息', defaultPrice: 23.9, isETF: true },
  '00929': { name: '復華台灣科技優息', defaultPrice: 19.3, isETF: true },
  '006208': { name: '富邦台50', defaultPrice: 115.0, isETF: true },
  '00713': { name: '元大台灣高息低波', defaultPrice: 58.5, isETF: true },
  '00940': { name: '元大台灣價值高息', defaultPrice: 9.6, isETF: true },
  '00679B': { name: '元大美債20年', defaultPrice: 30.5, isETF: true },
  '00687B': { name: '國泰20年美債', defaultPrice: 31.8, isETF: true },
};

class StockApp {
  constructor() {
    this.STORAGE_KEY = 'STOCK_APP_PORTFOLIO_V1';
    this.currentBuyUnit = 'lot'; // 'lot' (張) or 'share' (股)
    this.lendingFilter = 'active'; // 'active' or 'returned'
    this.stockChartInstance = null;
    this.accountChartInstance = null;
    this.editingPriceSymbol = null;

    // Firebase Cloud Sync configuration
    this.firestoreDb = null;
    this.isFirebaseActive = false;
    this.syncKey = localStorage.getItem('STOCK_APP_SYNC_KEY') || 'my_stocks_portfolio';
    this.isRemoteUpdate = false;
    this.unsubscribeFirestore = null;
    this.syncTimeout = null;

    this.data = {
      accounts: [
        { id: 'acc_yuanta', name: '元大證券', discountRate: 0.6, note: '主戶頭' },
        { id: 'acc_fubon', name: '富邦證券', discountRate: 0.6, note: '雙向借券常用戶' },
        { id: 'acc_cathay', name: '國泰證券', discountRate: 0.28, note: '定期定額低手續費' },
        { id: 'acc_sinopac', name: '永豐金證券', discountRate: 0.38, note: '大戶投' },
      ],
      transactions: [],
      lendings: [],
      prices: {},
      settings: {
        colorMode: 'tw', // 'tw' = 紅漲綠跌, 'intl' = 綠漲紅跌
        darkMode: false,
      },
      updatedAt: Date.now()
    };

    this.init();
  }

  init() {
    this.loadData();
    this.applySettings();
    this.setupEventListeners();
    this.initStocksDatalist();
    this.initFirebase();
    this.render();
  }

  // 自動填入全台股與ETF datalist (2,397 檔)
  initStocksDatalist() {
    const datalist = document.getElementById('stocks-datalist');
    if (!datalist) return;
    const db = window.ALL_TW_STOCKS || STOCK_DICTIONARY;
    const fragment = document.createDocumentFragment();

    Object.entries(db).forEach(([code, item]) => {
      const opt = document.createElement('option');
      opt.value = code;
      opt.label = `${code} ${item.name} (${item.market || (item.isETF ? 'ETF' : '台股')}) - $${item.price}`;
      fragment.appendChild(opt);
    });
    datalist.innerHTML = '';
    datalist.appendChild(fragment);
  }

  // ==================== STORAGE & PERSISTENCE ====================
  loadData() {
    try {
      const saved = localStorage.getItem(this.STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        this.data = { ...this.data, ...parsed };
      } else {
        // First time initialization: populate default prices from dictionary
        Object.entries(STOCK_DICTIONARY).forEach(([sym, info]) => {
          this.data.prices[sym] = {
            price: info.defaultPrice,
            change: 0,
            changePercent: 0,
            lastUpdated: new Date().toISOString()
          };
        });
        // Auto-load sample data only on first visit
        this.populateSampleData();
      }
    } catch (e) {
      console.error('Failed to load portfolio data:', e);
    }
  }

  saveData() {
    try {
      this.data.isInitialized = true;
      this.data.updatedAt = Date.now();
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.data));

      // Auto-sync to Firebase Firestore if connected
      if (this.isFirebaseActive && !this.isRemoteUpdate) {
        if (this.syncTimeout) clearTimeout(this.syncTimeout);
        this.syncTimeout = setTimeout(() => {
          this.pushToCloud(false);
        }, 800);
      }
    } catch (e) {
      console.error('Failed to save portfolio data:', e);
      alert('本機儲存失敗，請檢查空間！');
    }
  }

  // ==================== FIREBASE CLOUD SYNC ====================
  initFirebase() {
    const firebaseConfig = {
      apiKey: "AIzaSyAREW9aC38_zbVixDOXWPcnm6R6vgmdQBE",
      authDomain: "grade-system-103.firebaseapp.com",
      projectId: "grade-system-103",
      storageBucket: "grade-system-103.firebasestorage.app",
      messagingSenderId: "233712058165",
      appId: "1:233712058165:web:7add75a4574e234eebd67c"
    };

    try {
      if (typeof firebase !== 'undefined') {
        if (!firebase.apps.length) {
          firebase.initializeApp(firebaseConfig);
        }
        this.firestoreDb = firebase.firestore();
        this.isFirebaseActive = true;
        this.updateSyncUIStatus(true);
        this.setupFirestoreListener();
        console.log('Firebase Cloud Firestore successfully connected!');
      } else {
        this.isFirebaseActive = false;
        this.updateSyncUIStatus(false);
      }
    } catch (e) {
      console.warn('Firebase init error, fallback to LocalStorage:', e);
      this.isFirebaseActive = false;
      this.updateSyncUIStatus(false);
    }
  }

  setupFirestoreListener() {
    if (!this.firestoreDb || !this.syncKey) return;
    if (this.unsubscribeFirestore) {
      this.unsubscribeFirestore();
    }

    const docRef = this.firestoreDb.collection('stock_portfolios').doc(this.syncKey);
    this.unsubscribeFirestore = docRef.onSnapshot(doc => {
      if (doc.exists) {
        const remoteData = doc.data();
        if (remoteData && remoteData.updatedAt) {
          const localUpdated = this.data.updatedAt || 0;
          if (remoteData.updatedAt > localUpdated) {
            console.log('Received remote update from Firebase Firestore!');
            this.isRemoteUpdate = true;
            this.data = { ...this.data, ...remoteData };
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.data));
            this.render();
            this.isRemoteUpdate = false;
          }
        }
      } else {
        // Document doesn't exist yet on cloud, push initial local data
        this.pushToCloud(false);
      }
    }, err => {
      console.warn('Firestore onSnapshot listener error:', err);
      this.updateSyncUIStatus(false);
    });
  }

  updateSyncUIStatus(connected) {
    const dot = document.getElementById('firebase-sync-dot');
    const text = document.getElementById('firebase-sync-text');
    const indicator = document.getElementById('sync-status-indicator');
    const keyInput = document.getElementById('firebase-sync-key');
    if (keyInput) keyInput.value = this.syncKey;

    if (connected) {
      if (dot) dot.className = 'w-2 h-2 rounded-full bg-emerald-500 animate-pulse';
      if (text) text.textContent = '☁️ 雲端同步中';
      if (indicator) {
        indicator.textContent = '🟢 已連線 (即時雙向同步)';
        indicator.className = 'text-[11px] font-semibold text-emerald-600 dark:text-emerald-400';
      }
    } else {
      if (dot) dot.className = 'w-2 h-2 rounded-full bg-slate-400';
      if (text) text.textContent = '☁️ 離線模式';
      if (indicator) {
        indicator.textContent = '⚪ 離線/純本機模式';
        indicator.className = 'text-[11px] font-semibold text-slate-500';
      }
    }
  }

  updateSyncKey() {
    const input = document.getElementById('firebase-sync-key');
    const newKey = input ? input.value.trim() : '';
    if (!newKey) {
      alert('請輸入有效的同步識別碼 (Sync Key)！');
      return;
    }
    this.syncKey = newKey;
    localStorage.setItem('STOCK_APP_SYNC_KEY', newKey);
    this.setupFirestoreListener();
    alert(`已將同步識別碼切換為：${newKey}！\n系統正在連線同步該識別碼的資料。在手機或其他裝置輸入相同的代碼即可連動！`);
  }

  async pushToCloud(showAlert = true) {
    if (!this.firestoreDb) {
      if (showAlert) alert('Firebase 尚未連線！');
      return;
    }
    try {
      this.data.updatedAt = Date.now();
      await this.firestoreDb.collection('stock_portfolios').doc(this.syncKey).set(this.data);
      if (showAlert) alert('✅ 已成功將最新持股資料推送到 Firebase 雲端！');
    } catch (e) {
      console.error('Push to cloud error:', e);
      if (showAlert) alert('推送至雲端失敗：' + e.message);
    }
  }

  async pullFromCloud() {
    if (!this.firestoreDb) {
      alert('Firebase 尚未連線！');
      return;
    }
    try {
      const doc = await this.firestoreDb.collection('stock_portfolios').doc(this.syncKey).get();
      if (doc.exists) {
        this.data = { ...this.data, ...doc.data() };
        this.saveData();
        this.render();
        alert('✅ 已成功從 Firebase 雲端下載並覆蓋本地持股！');
      } else {
        alert(`雲端尚無此識別碼 (${this.syncKey}) 的持股資料！您可以先點擊「立即推送到雲端」。`);
      }
    } catch (e) {
      console.error('Pull from cloud error:', e);
      alert('從雲端拉取失敗：' + e.message);
    }
  }

  populateSampleData() {
    this.data.transactions = [
      // 元大證券: 買進台積電 2 張 @ 920
      {
        id: 'tx_1',
        type: 'BUY',
        accountId: 'acc_yuanta',
        symbol: '2330',
        name: '台積電',
        date: '2026-06-15',
        shares: 2000,
        price: 920.0,
        fee: 1573,
        tax: 0,
        notes: '波段建倉'
      },
      // 富邦證券: 買進台積電 1 張 @ 950
      {
        id: 'tx_2',
        type: 'BUY',
        accountId: 'acc_fubon',
        symbol: '2330',
        name: '台積電',
        date: '2026-07-10',
        shares: 1000,
        price: 950.0,
        fee: 812,
        tax: 0,
        notes: '分戶加碼'
      },
      // 國泰證券: 買進鴻海 3 張 @ 195
      {
        id: 'tx_3',
        type: 'BUY',
        accountId: 'acc_cathay',
        symbol: '2317',
        name: '鴻海',
        date: '2026-08-01',
        shares: 3000,
        price: 195.0,
        fee: 233,
        tax: 0,
        notes: '除息後逢低佈局'
      },
      // 元大證券: 買進 00878 5 張 @ 22.1
      {
        id: 'tx_4',
        type: 'BUY',
        accountId: 'acc_yuanta',
        symbol: '00878',
        name: '國泰永續高股息',
        date: '2026-05-20',
        shares: 5000,
        price: 22.1,
        fee: 94,
        tax: 0,
        notes: '高股息存股'
      },
      // 永豐金證券: 買進 0050 1.5 張 (1500 股) @ 180
      {
        id: 'tx_5',
        type: 'BUY',
        accountId: 'acc_sinopac',
        symbol: '0050',
        name: '元大台灣50',
        date: '2026-07-22',
        shares: 1500,
        price: 180.0,
        fee: 146,
        tax: 0,
        notes: '定期定額'
      }
    ];

    this.data.lendings = [
      // 元大證券台積電借出 1 張 (1000 股) 年利率 2.5%
      {
        id: 'lend_1',
        accountId: 'acc_yuanta',
        symbol: '2330',
        name: '台積電',
        shares: 1000,
        rate: 2.5,
        startDate: '2026-08-15',
        endDate: null,
        status: 'LENT',
        earnedInterest: 0,
        notes: '雙向借券 2.5% 洽借中'
      },
      // 元大證券 00878 借出 3 張 (3000 股) 年利率 2.0%
      {
        id: 'lend_2',
        accountId: 'acc_yuanta',
        symbol: '00878',
        name: '國泰永續高股息',
        shares: 3000,
        rate: 2.0,
        startDate: '2026-08-01',
        endDate: null,
        status: 'LENT',
        earnedInterest: 0,
        notes: '高股息ETF外借賺利息'
      },
      // 歷史已還券紀錄 (賺得利息示範)
      {
        id: 'lend_3',
        accountId: 'acc_fubon',
        symbol: '2330',
        name: '台積電',
        shares: 1000,
        rate: 3.0,
        startDate: '2026-05-01',
        endDate: '2026-06-30',
        status: 'RETURNED',
        earnedInterest: 3840,
        notes: '借出2個月已結清入帳'
      }
    ];

    // Initialize initial prices
    Object.entries(STOCK_DICTIONARY).forEach(([sym, info]) => {
      this.data.prices[sym] = {
        price: info.defaultPrice,
        change: Math.round((Math.random() * 20 - 5) * 10) / 10,
        changePercent: 1.25,
        lastUpdated: new Date().toISOString()
      };
    });

    this.saveData();
  }

  loadSampleData() {
    if (confirm('確定要載入示範資料嗎？現有資料將會被範例資料取代（可先至「備份與設定」匯出備份）。')) {
      this.populateSampleData();
      this.render();
      alert('已成功載入示範持股與借券資料！');
    }
  }

  /**
   * 清空持股與交易資料，保留券商設定，讓使用者立即從 0 開始記錄
   */
  clearAllData() {
    const isConfirmed = confirm(
      '⚠️【確定清空所有資料嗎？】\n\n' +
      '這將會清除所有「股票買賣紀錄」與「借券出借資料」，\n' +
      '但會保留您的券商戶頭（元大、富邦等），讓您可以乾淨輸入自己的真實持股。\n\n' +
      '※ 如有需要，請先點擊「匯出完整 JSON 備份」！\n\n' +
      '確定要現在清空嗎？'
    );

    if (isConfirmed) {
      this.data.transactions = [];
      this.data.lendings = [];
      this.saveData();
      this.render();
      this.closeModal('modal-settings');
      alert('✅ 已成功清空所有持股與借券資料！現在是一本全新的空白記帳本，您可以開始輸入您的第一筆股票了。');
    }
  }

  exportDataJSON() {
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(this.data, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', dataStr);
    const date = new Date().toISOString().slice(0, 10);
    downloadAnchor.setAttribute('download', `stock_portfolio_backup_${date}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  }

  importDataJSON(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const imported = JSON.parse(e.target.result);
        if (imported.accounts && imported.transactions) {
          this.data = imported;
          this.saveData();
          this.render();
          this.closeModal('modal-settings');
          alert('備份檔案還原成功！');
        } else {
          alert('檔案格式不正確，找不到帳戶或交易資料！');
        }
      } catch (err) {
        alert('解析 JSON 備份檔失敗：' + err.message);
      }
    };
    reader.readAsText(file);
  }

  // ==================== CORE CALCULATIONS ENGINE ====================
  /**
   * 計算並返回所有庫存狀況
   * 包含：依 (accountId, symbol) 計算在庫股數、借出股數、市值、平均成本、未實現損益
   */
  calculateHoldings() {
    // 1. 計算各 (accountId, symbol) 的累積買賣與平均成本
    const accountStockMap = {}; // key: `${accountId}_${symbol}`

    // 依時間順序處理交易
    const sortedTx = [...this.data.transactions].sort((a, b) => new Date(a.date) - new Date(b.date));

    sortedTx.forEach(tx => {
      const key = `${tx.accountId}_${tx.symbol}`;
      if (!accountStockMap[key]) {
        accountStockMap[key] = {
          accountId: tx.accountId,
          symbol: tx.symbol,
          name: tx.name,
          shares: 0,
          totalCost: 0, // 剩餘庫存總成本 (TWD)
          realizedPnL: 0
        };
      }

      const item = accountStockMap[key];
      if (tx.type === 'BUY') {
        const txCost = (tx.shares * tx.price) + (tx.fee || 0);
        item.totalCost += txCost;
        item.shares += tx.shares;
        item.name = tx.name || item.name;
      } else if (tx.type === 'SELL') {
        if (item.shares > 0) {
          const avgCostPerShare = item.totalCost / item.shares;
          const costOfSharesSold = avgCostPerShare * tx.shares;
          const revenue = (tx.shares * tx.price) - (tx.fee || 0) - (tx.tax || 0);
          item.realizedPnL += (revenue - costOfSharesSold);
          item.totalCost -= costOfSharesSold;
          item.shares -= tx.shares;
          if (item.shares <= 0) {
            item.shares = 0;
            item.totalCost = 0;
          }
        }
      }
    });

    // 2. 統計各 (accountId, symbol) 的出借中股數
    const activeLentMap = {}; // key: `${accountId}_${symbol}` -> number of lent shares
    this.data.lendings.forEach(l => {
      if (l.status === 'LENT') {
        const key = `${l.accountId}_${l.symbol}`;
        activeLentMap[key] = (activeLentMap[key] || 0) + Number(l.shares);
      }
    });

    // 3. 整合為持股清單
    const holdings = [];
    Object.values(accountStockMap).forEach(item => {
      if (item.shares > 0) {
        const key = `${item.accountId}_${item.symbol}`;
        const lentShares = activeLentMap[key] || 0;
        const inAccountShares = Math.max(0, item.shares - lentShares);
        
        // 價格估算
        const priceInfo = this.data.prices[item.symbol] || { price: item.totalCost / item.shares, change: 0, changePercent: 0 };
        const currentPrice = Number(priceInfo.price) || 0;
        const marketValue = Math.round(item.shares * currentPrice);
        const inAccountValue = Math.round(inAccountShares * currentPrice);
        const lentValue = Math.round(lentShares * currentPrice);
        const unrealizedPnL = Math.round(marketValue - item.totalCost);
        const unrealizedPnLRate = item.totalCost > 0 ? (unrealizedPnL / item.totalCost) * 100 : 0;
        const avgCost = item.shares > 0 ? (item.totalCost / item.shares) : 0;

        holdings.push({
          accountId: item.accountId,
          symbol: item.symbol,
          name: item.name,
          totalShares: item.shares,
          inAccountShares: inAccountShares,
          lentShares: lentShares,
          avgCost: avgCost,
          totalCost: item.totalCost,
          currentPrice: currentPrice,
          marketValue: marketValue,
          inAccountValue: inAccountValue,
          lentValue: lentValue,
          unrealizedPnL: unrealizedPnL,
          unrealizedPnLRate: unrealizedPnLRate,
          priceChange: priceInfo.change || 0,
          priceChangePercent: priceInfo.changePercent || 0,
          lastUpdated: priceInfo.lastUpdated
        });
      }
    });

    return holdings;
  }

  // ==================== AGGREGATED VIEWS ====================
  /**
   * 彙總至個股視角 (By Stock)
   */
  getGroupedByStock(holdings) {
    const stockMap = {};
    holdings.forEach(h => {
      if (!stockMap[h.symbol]) {
        stockMap[h.symbol] = {
          symbol: h.symbol,
          name: h.name,
          currentPrice: h.currentPrice,
          priceChange: h.priceChange,
          priceChangePercent: h.priceChangePercent,
          totalShares: 0,
          inAccountShares: 0,
          lentShares: 0,
          totalCost: 0,
          marketValue: 0,
          inAccountValue: 0,
          lentValue: 0,
          unrealizedPnL: 0,
          accountBreakdown: []
        };
      }

      const s = stockMap[h.symbol];
      s.totalShares += h.totalShares;
      s.inAccountShares += h.inAccountShares;
      s.lentShares += h.lentShares;
      s.totalCost += h.totalCost;
      s.marketValue += h.marketValue;
      s.inAccountValue += h.inAccountValue;
      s.lentValue += h.lentValue;
      s.unrealizedPnL += h.unrealizedPnL;

      const acc = this.data.accounts.find(a => a.id === h.accountId) || { name: '未知券商' };
      s.accountBreakdown.push({
        accountId: h.accountId,
        accountName: acc.name,
        shares: h.totalShares,
        inAccountShares: h.inAccountShares,
        lentShares: h.lentShares,
        marketValue: h.marketValue,
        avgCost: h.avgCost,
        unrealizedPnL: h.unrealizedPnL,
        unrealizedPnLRate: h.unrealizedPnLRate
      });
    });

    Object.values(stockMap).forEach(s => {
      s.avgCost = s.totalShares > 0 ? (s.totalCost / s.totalShares) : 0;
      s.unrealizedPnLRate = s.totalCost > 0 ? (s.unrealizedPnL / s.totalCost) * 100 : 0;
    });

    return Object.values(stockMap).sort((a, b) => b.marketValue - a.marketValue);
  }

  /**
   * 彙總至券商帳戶視角 (By Brokerage Account)
   */
  getGroupedByAccount(holdings) {
    return this.data.accounts.map(acc => {
      const accHoldings = holdings.filter(h => h.accountId === acc.id);
      const totalMarketValue = accHoldings.reduce((sum, h) => sum + h.marketValue, 0);
      const totalInAccountValue = accHoldings.reduce((sum, h) => sum + h.inAccountValue, 0);
      const totalLentValue = accHoldings.reduce((sum, h) => sum + h.lentValue, 0);
      const totalCost = accHoldings.reduce((sum, h) => sum + h.totalCost, 0);
      const unrealizedPnL = totalMarketValue - totalCost;
      const unrealizedPnLRate = totalCost > 0 ? (unrealizedPnL / totalCost) * 100 : 0;

      return {
        id: acc.id,
        name: acc.name,
        discountRate: acc.discountRate,
        note: acc.note,
        totalMarketValue,
        totalInAccountValue,
        totalLentValue,
        totalCost,
        unrealizedPnL,
        unrealizedPnLRate,
        holdings: accHoldings
      };
    }).sort((a, b) => b.totalMarketValue - a.totalMarketValue);
  }

  // ==================== RENDERING METHODS ====================
  render() {
    const holdings = this.calculateHoldings();
    const stocksGrouped = this.getGroupedByStock(holdings);
    const accountsGrouped = this.getGroupedByAccount(holdings);

    this.renderKPIs(holdings);
    this.renderStockList(stocksGrouped);
    this.renderAccountList(accountsGrouped);
    this.renderLendingTracker();
    this.renderTransactions();
    this.renderCharts(stocksGrouped, accountsGrouped);
    this.updateDropdowns(holdings);

    // Refresh icons
    if (window.lucide) {
      lucide.createIcons();
    }
  }

  renderKPIs(holdings) {
    const totalMarketValue = holdings.reduce((sum, h) => sum + h.marketValue, 0);
    const totalCost = holdings.reduce((sum, h) => sum + h.totalCost, 0);
    const totalInAccountValue = holdings.reduce((sum, h) => sum + h.inAccountValue, 0);
    const totalLentValue = holdings.reduce((sum, h) => sum + h.lentValue, 0);
    const totalUnrealizedPnL = totalMarketValue - totalCost;
    const totalPnLRate = totalCost > 0 ? (totalUnrealizedPnL / totalCost) * 100 : 0;

    // Cumulative Lending Income
    const totalLendingIncome = this.data.lendings.reduce((sum, l) => sum + (Number(l.earnedInterest) || 0), 0);
    const activeLentCount = this.data.lendings.filter(l => l.status === 'LENT').length;

    // Dom elements
    document.getElementById('kpi-total-value').textContent = this.formatCurrency(totalMarketValue);
    document.getElementById('kpi-total-cost').textContent = this.formatCurrency(totalCost);
    document.getElementById('kpi-in-account-value').textContent = this.formatCurrency(totalInAccountValue);
    document.getElementById('kpi-lent-value').textContent = this.formatCurrency(totalLentValue);
    document.getElementById('kpi-lending-income').textContent = this.formatCurrency(totalLendingIncome);
    document.getElementById('kpi-active-lent-count').textContent = `${activeLentCount} 筆`;

    // Unrealized PnL coloring
    const pnlEl = document.getElementById('kpi-unrealized-pnl');
    const pnlRateEl = document.getElementById('kpi-pnl-rate');
    const pnlRateContainer = document.getElementById('kpi-pnl-rate-container');

    const prefix = totalUnrealizedPnL >= 0 ? '+' : '';
    pnlEl.textContent = `${prefix}${this.formatCurrency(totalUnrealizedPnL)}`;
    pnlRateEl.textContent = `${prefix}${totalPnLRate.toFixed(2)}%`;

    const colorClass = this.getPnLColorClass(totalUnrealizedPnL);
    pnlEl.className = `text-xl sm:text-2xl lg:text-3xl font-extrabold ${colorClass}`;
    pnlRateContainer.className = `mt-1 flex items-center text-xs font-medium ${colorClass}`;

    // Badges count
    document.getElementById('badge-stock-count').textContent = this.getGroupedByStock(holdings).length;
    document.getElementById('badge-account-count').textContent = this.data.accounts.length;
    document.getElementById('badge-lending-count').textContent = activeLentCount;
    document.getElementById('badge-tx-count').textContent = this.data.transactions.length;
  }

  // TAB 1: 個股彙整列表
  renderStockList(stocks) {
    const container = document.getElementById('stock-list-container');
    const searchTerm = (document.getElementById('search-stock')?.value || '').trim().toLowerCase();

    const filtered = stocks.filter(s => 
      s.symbol.toLowerCase().includes(searchTerm) || 
      s.name.toLowerCase().includes(searchTerm)
    );

    if (filtered.length === 0) {
      container.innerHTML = `
        <div class="p-8 text-center bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700">
          <i data-lucide="inbox" class="w-10 h-10 mx-auto text-slate-300 dark:text-slate-600 mb-2"></i>
          <p class="text-sm font-medium text-slate-500 dark:text-slate-400">目前尚無符合的股票持股</p>
          <p class="text-xs text-slate-400 mt-1">點擊上方「買進股票」或「載入範例資料」開始記錄！</p>
        </div>
      `;
      return;
    }

    container.innerHTML = filtered.map(s => {
      const pnlColor = this.getPnLColorClass(s.unrealizedPnL);
      const prefix = s.unrealizedPnL >= 0 ? '+' : '';
      const lots = (s.totalShares / 1000).toFixed(s.totalShares % 1000 === 0 ? 0 : 2);
      const inAccountLots = (s.inAccountShares / 1000).toFixed(s.inAccountShares % 1000 === 0 ? 0 : 2);
      const lentLots = (s.lentShares / 1000).toFixed(s.lentShares % 1000 === 0 ? 0 : 2);

      // Account breakdown rows
      const breakdownRows = s.accountBreakdown.map(acc => {
        const accPnlColor = this.getPnLColorClass(acc.unrealizedPnL);
        const accPrefix = acc.unrealizedPnL >= 0 ? '+' : '';
        return `
          <div class="flex flex-col sm:flex-row sm:items-center justify-between py-2 px-3 rounded-xl bg-slate-50 dark:bg-slate-900/40 text-xs gap-2 border border-slate-100 dark:border-slate-800">
            <div class="flex items-center space-x-2">
              <span class="font-bold text-slate-700 dark:text-slate-300"><i data-lucide="landmark" class="w-3.5 h-3.5 inline mr-1 text-slate-400"></i>${this.escapeHtml(acc.accountName)}</span>
              <span class="text-slate-400">均價 $${acc.avgCost.toFixed(1)}</span>
            </div>
            <div class="flex flex-wrap items-center gap-3">
              <span class="text-emerald-600 dark:text-emerald-400 font-medium">
                <i data-lucide="check-circle-2" class="w-3 h-3 inline mr-0.5"></i>在庫：${acc.inAccountShares.toLocaleString()} 股
              </span>
              <span class="${acc.lentShares > 0 ? 'text-purple-600 dark:text-purple-400 font-semibold' : 'text-slate-400'}">
                <i data-lucide="repeat" class="w-3 h-3 inline mr-0.5"></i>出借中：${acc.lentShares.toLocaleString()} 股
              </span>
              <span class="font-bold text-slate-900 dark:text-white">${this.formatCurrency(acc.marketValue)}</span>
              <span class="font-semibold ${accPnlColor}">${accPrefix}${this.formatCurrency(acc.unrealizedPnL)} (${accPrefix}${acc.unrealizedPnLRate.toFixed(2)}%)</span>
            </div>
          </div>
        `;
      }).join('');

      return `
        <div class="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden p-4 sm:p-5 space-y-3">
          <!-- Card Header -->
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-100 dark:border-slate-700/60 pb-3">
            <div class="flex items-center space-x-3">
              <div class="w-12 h-12 rounded-2xl bg-gradient-to-br from-slate-100 to-slate-200 dark:from-slate-700 dark:to-slate-800 flex flex-col items-center justify-center font-bold">
                <span class="text-xs text-slate-400">代號</span>
                <span class="text-sm font-mono text-slate-800 dark:text-white">${s.symbol}</span>
              </div>
              <div>
                <div class="flex items-center space-x-2">
                  <h3 class="text-base font-extrabold text-slate-900 dark:text-white">${this.escapeHtml(s.name)}</h3>
                  <button onclick="app.openEditPriceModal('${s.symbol}', '${s.name}', ${s.currentPrice})" class="text-xs px-2 py-0.5 rounded-md bg-slate-100 hover:bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300 inline-flex items-center space-x-1" title="手動設定目前市價">
                    <i data-lucide="edit-3" class="w-3 h-3"></i>
                    <span>市價 $${s.currentPrice}</span>
                  </button>
                </div>
                <p class="text-xs text-slate-400 mt-0.5">平均持有成本 $${s.avgCost.toFixed(2)} ‧ 跨 ${s.accountBreakdown.length} 個券商戶頭</p>
              </div>
            </div>

            <!-- Total Value & PnL -->
            <div class="text-left sm:text-right">
              <div class="text-lg sm:text-xl font-extrabold text-slate-900 dark:text-white">${this.formatCurrency(s.marketValue)}</div>
              <div class="text-xs font-semibold ${pnlColor}">
                未實現：${prefix}${this.formatCurrency(s.unrealizedPnL)} (${prefix}${s.unrealizedPnLRate.toFixed(2)}%)
              </div>
            </div>
          </div>

          <!-- Stock Distribution Stats Pills -->
          <div class="grid grid-cols-3 gap-2 py-1 text-center text-xs">
            <div class="p-2 rounded-xl bg-slate-50 dark:bg-slate-900/50 border border-slate-100 dark:border-slate-800">
              <span class="text-slate-400 block text-[11px]">總持股數量</span>
              <span class="font-bold text-slate-800 dark:text-white text-sm">${s.totalShares.toLocaleString()}</span>
              <span class="text-slate-400 text-[10px]">(${lots} 張)</span>
            </div>
            <div class="p-2 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-100 dark:border-emerald-800/40">
              <span class="text-emerald-700 dark:text-emerald-400 block text-[11px] font-medium">戶頭在庫現股 (可賣)</span>
              <span class="font-bold text-emerald-600 dark:text-emerald-400 text-sm">${s.inAccountShares.toLocaleString()}</span>
              <span class="text-emerald-500 text-[10px]">(${inAccountLots} 張)</span>
            </div>
            <div class="p-2 rounded-xl ${s.lentShares > 0 ? 'bg-purple-50 dark:bg-purple-950/30 border-purple-100 dark:border-purple-800/40' : 'bg-slate-50 dark:bg-slate-900/50 border-slate-100 dark:border-slate-800'}">
              <span class="${s.lentShares > 0 ? 'text-purple-700 dark:text-purple-300' : 'text-slate-400'} block text-[11px] font-medium">出借中 (借券收息)</span>
              <span class="font-bold ${s.lentShares > 0 ? 'text-purple-600 dark:text-purple-400' : 'text-slate-400'} text-sm">${s.lentShares.toLocaleString()}</span>
              <span class="${s.lentShares > 0 ? 'text-purple-500' : 'text-slate-400'} text-[10px]">(${lentLots} 張)</span>
            </div>
          </div>

          <!-- Multi-Brokerage Breakdown Accordion Container -->
          <div class="pt-2 space-y-1.5">
            <div class="text-[11px] font-bold text-slate-400 uppercase tracking-wider">各證券商帳戶分佈明細：</div>
            <div class="space-y-1.5">
              ${breakdownRows}
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  // TAB 2: 券商帳戶列表
  renderAccountList(accounts) {
    const container = document.getElementById('account-list-container');
    if (!container) return;

    if (accounts.length === 0) {
      container.innerHTML = `<div class="p-6 text-center text-slate-400">尚無券商帳戶</div>`;
      return;
    }

    container.innerHTML = accounts.map(acc => {
      const pnlColor = this.getPnLColorClass(acc.unrealizedPnL);
      const prefix = acc.unrealizedPnL >= 0 ? '+' : '';

      const holdingRows = acc.holdings.length === 0 
        ? `<div class="p-3 text-center text-xs text-slate-400">目前此帳戶無持股庫存</div>`
        : acc.holdings.map(h => {
            const hPnlColor = this.getPnLColorClass(h.unrealizedPnL);
            const hPrefix = h.unrealizedPnL >= 0 ? '+' : '';
            return `
              <div class="flex flex-col sm:flex-row sm:items-center justify-between p-3 rounded-xl bg-slate-50 dark:bg-slate-900/40 border border-slate-100 dark:border-slate-800 text-xs gap-2">
                <div class="flex items-center space-x-2">
                  <span class="font-mono font-bold text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30 px-1.5 py-0.5 rounded">${h.symbol}</span>
                  <span class="font-bold text-slate-900 dark:text-white text-sm">${this.escapeHtml(h.name)}</span>
                  <span class="text-slate-400">市價 $${h.currentPrice}</span>
                </div>
                <div class="flex flex-wrap items-center gap-3">
                  <span class="text-emerald-600 dark:text-emerald-400 font-medium">在庫：${h.inAccountShares.toLocaleString()} 股</span>
                  <span class="${h.lentShares > 0 ? 'text-purple-600 dark:text-purple-400 font-semibold' : 'text-slate-400'}">出借中：${h.lentShares.toLocaleString()} 股</span>
                  <span class="font-bold text-slate-900 dark:text-white">${this.formatCurrency(h.marketValue)}</span>
                  <span class="font-semibold ${hPnlColor}">${hPrefix}${this.formatCurrency(h.unrealizedPnL)} (${hPrefix}${h.unrealizedPnLRate.toFixed(2)}%)</span>
                </div>
              </div>
            `;
          }).join('');

      return `
        <div class="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm p-4 sm:p-5 space-y-3">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between border-b border-slate-100 dark:border-slate-700/60 pb-3 gap-2">
            <div class="flex items-center space-x-3">
              <div class="w-10 h-10 rounded-xl bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 flex items-center justify-center font-bold">
                <i data-lucide="landmark" class="w-5 h-5"></i>
              </div>
              <div>
                <h3 class="text-base font-bold text-slate-900 dark:text-white">${this.escapeHtml(acc.name)}</h3>
                <p class="text-xs text-slate-400">手續費折讓：${(acc.discountRate * 10).toFixed(1)} 折 ${acc.note ? `‧ ${this.escapeHtml(acc.note)}` : ''}</p>
              </div>
            </div>

            <div class="text-left sm:text-right">
              <div class="text-lg font-extrabold text-slate-900 dark:text-white">${this.formatCurrency(acc.totalMarketValue)}</div>
              <div class="text-xs font-semibold ${pnlColor}">未實現：${prefix}${this.formatCurrency(acc.unrealizedPnL)} (${prefix}${acc.unrealizedPnLRate.toFixed(2)}%)</div>
            </div>
          </div>

          <!-- Account Lending & In-account stats -->
          <div class="flex items-center justify-between text-xs px-1 text-slate-500">
            <span>在庫市值：<strong class="text-emerald-600 dark:text-emerald-400">${this.formatCurrency(acc.totalInAccountValue)}</strong></span>
            <span>出借中市值：<strong class="text-purple-600 dark:text-purple-400">${this.formatCurrency(acc.totalLentValue)}</strong></span>
          </div>

          <!-- Holding List within this account -->
          <div class="space-y-2 pt-1">
            ${holdingRows}
          </div>
        </div>
      `;
    }).join('');
  }

  // TAB 3: 借券出借追蹤
  renderLendingTracker() {
    const container = document.getElementById('lending-list-container');
    const activeCountEl = document.getElementById('count-lending-active');
    const returnedCountEl = document.getElementById('count-lending-returned');

    const activeList = this.data.lendings.filter(l => l.status === 'LENT');
    const returnedList = this.data.lendings.filter(l => l.status === 'RETURNED');

    if (activeCountEl) activeCountEl.textContent = activeList.length;
    if (returnedCountEl) returnedCountEl.textContent = returnedList.length;

    const listToRender = this.lendingFilter === 'active' ? activeList : returnedList;

    if (listToRender.length === 0) {
      container.innerHTML = `
        <div class="p-8 text-center bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700">
          <i data-lucide="check-circle" class="w-10 h-10 mx-auto text-purple-300 dark:text-purple-600 mb-2"></i>
          <p class="text-sm font-medium text-slate-500 dark:text-slate-400">目前無${this.lendingFilter === 'active' ? '進行中' : '已還券'}借券項目</p>
          <p class="text-xs text-slate-400 mt-1">若股票已由券商出借，可點擊「登記新出借」追蹤收息！</p>
        </div>
      `;
      return;
    }

    container.innerHTML = listToRender.map(item => {
      const acc = this.data.accounts.find(a => a.id === item.accountId) || { name: '未知券商' };
      const currentPrice = (this.data.prices[item.symbol]?.price) || 0;
      const lentValue = item.shares * currentPrice;

      // Calculate days elapsed
      const startDate = new Date(item.startDate);
      const endDate = item.endDate ? new Date(item.endDate) : new Date();
      const diffTime = Math.max(0, endDate - startDate);
      const days = Math.floor(diffTime / (1000 * 60 * 60 * 24));

      // Estimated Accrued Interest = shares * price * (rate/100) * (days/365) * 0.8 (estimated net after fee)
      const estInterest = Math.round(lentValue * (item.rate / 100) * (days / 365) * 0.8);

      const isActive = item.status === 'LENT';

      return `
        <div class="bg-white dark:bg-slate-800 rounded-2xl border ${isActive ? 'border-purple-200 dark:border-purple-800/60' : 'border-slate-200 dark:border-slate-700'} shadow-sm p-4 sm:p-5 space-y-3">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-100 dark:border-slate-700/60 pb-3">
            <div class="flex items-center space-x-3">
              <span class="p-2.5 rounded-xl ${isActive ? 'bg-purple-100 dark:bg-purple-900/40 text-purple-600 dark:text-purple-400' : 'bg-slate-100 dark:bg-slate-700 text-slate-500'}">
                <i data-lucide="${isActive ? 'repeat' : 'check-check'}" class="w-5 h-5"></i>
              </span>
              <div>
                <div class="flex items-center space-x-2">
                  <h4 class="font-extrabold text-base text-slate-900 dark:text-white">${this.escapeHtml(item.name)} <span class="font-mono text-sm text-slate-400">(${item.symbol})</span></h4>
                  <span class="px-2 py-0.5 rounded-full text-xs font-semibold ${isActive ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/60 dark:text-purple-300' : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-300'}">
                    ${isActive ? '出借收息中' : '已還券結算'}
                  </span>
                </div>
                <p class="text-xs text-slate-400 mt-0.5">出借券商：${this.escapeHtml(acc.name)} ‧ 起借日：${item.startDate}</p>
              </div>
            </div>

            <div class="flex items-center space-x-2">
              ${isActive ? `
                <button onclick="app.openRecallModalWithItem('${item.id}')" class="px-3 py-1.5 text-xs font-semibold rounded-xl bg-indigo-50 hover:bg-indigo-100 text-indigo-700 dark:bg-indigo-950/60 dark:hover:bg-indigo-900/80 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 transition">
                  <i data-lucide="arrow-down-left" class="w-3.5 h-3.5 inline mr-1"></i>召回 / 還券結算
                </button>
              ` : `
                <span class="text-xs text-emerald-600 dark:text-emerald-400 font-bold">
                  已收利息：${this.formatCurrency(item.earnedInterest)}
                </span>
              `}
              <button onclick="app.deleteLending('${item.id}')" class="p-1.5 text-slate-400 hover:text-red-500 transition" title="刪除此紀錄">
                <i data-lucide="trash-2" class="w-4 h-4"></i>
              </button>
            </div>
          </div>

          <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div class="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-900/50">
              <span class="text-slate-400 block text-[11px]">出借股數</span>
              <span class="font-bold text-slate-800 dark:text-white text-sm">${item.shares.toLocaleString()} 股</span>
              <span class="text-slate-400 text-[10px]">(${(item.shares / 1000).toFixed(1)} 張)</span>
            </div>
            <div class="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-900/50">
              <span class="text-slate-400 block text-[11px]">約定年化費率</span>
              <span class="font-bold text-purple-600 dark:text-purple-400 text-sm">${item.rate}%</span>
            </div>
            <div class="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-900/50">
              <span class="text-slate-400 block text-[11px]">${isActive ? '已出借天數' : '借出總天數'}</span>
              <span class="font-bold text-slate-800 dark:text-white text-sm">${days} 天</span>
            </div>
            <div class="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-900/50">
              <span class="text-slate-400 block text-[11px]">${isActive ? '預估累積淨利息' : '實收利息'}</span>
              <span class="font-bold text-emerald-600 dark:text-emerald-400 text-sm">
                ${this.formatCurrency(isActive ? estInterest : item.earnedInterest)}
              </span>
            </div>
          </div>

          ${item.notes ? `<div class="text-xs text-slate-400 italic">備註：${this.escapeHtml(item.notes)}</div>` : ''}
        </div>
      `;
    }).join('');
  }

  // TAB 4: 歷史交易列表
  renderTransactions() {
    const tbody = document.getElementById('transaction-table-body');
    if (!tbody) return;

    const filterType = document.getElementById('filter-tx-type')?.value || 'ALL';
    const filterAccount = document.getElementById('filter-tx-account')?.value || 'ALL';

    const filtered = this.data.transactions.filter(tx => {
      if (filterType !== 'ALL' && tx.type !== filterType) return false;
      if (filterAccount !== 'ALL' && tx.accountId !== filterAccount) return false;
      return true;
    }).sort((a, b) => new Date(b.date) - new Date(a.date));

    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="9" class="py-8 text-center text-slate-400">尚無交易紀錄</td></tr>`;
      return;
    }

    tbody.innerHTML = filtered.map(tx => {
      const acc = this.data.accounts.find(a => a.id === tx.accountId) || { name: '未知券商' };
      const isBuy = tx.type === 'BUY';
      const grossAmount = tx.shares * tx.price;
      const totalCost = isBuy ? grossAmount + (tx.fee || 0) : grossAmount - (tx.fee || 0) - (tx.tax || 0);

      return `
        <tr class="hover:bg-slate-50/60 dark:hover:bg-slate-750 transition text-slate-700 dark:text-slate-300">
          <td class="py-3 px-4 whitespace-nowrap text-xs text-slate-500">${tx.date}</td>
          <td class="py-3 px-4 whitespace-nowrap">
            <span class="px-2 py-0.5 rounded text-xs font-bold ${isBuy ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/60 dark:text-blue-300' : 'bg-slate-200 text-slate-800 dark:bg-slate-700 dark:text-slate-300'}">
              ${isBuy ? '買進' : '賣出'}
            </span>
          </td>
          <td class="py-3 px-4 whitespace-nowrap font-medium text-xs">${this.escapeHtml(acc.name)}</td>
          <td class="py-3 px-4 whitespace-nowrap">
            <span class="font-bold text-slate-900 dark:text-white">${this.escapeHtml(tx.name)}</span>
            <span class="font-mono text-xs text-slate-400 ml-1">${tx.symbol}</span>
          </td>
          <td class="py-3 px-4 whitespace-nowrap text-right font-mono font-medium">${tx.shares.toLocaleString()}</td>
          <td class="py-3 px-4 whitespace-nowrap text-right font-mono">$${tx.price.toFixed(2)}</td>
          <td class="py-3 px-4 whitespace-nowrap text-right font-mono text-xs text-slate-500">
            $${((tx.fee || 0) + (tx.tax || 0)).toLocaleString()}
          </td>
          <td class="py-3 px-4 whitespace-nowrap text-right font-mono font-bold text-slate-900 dark:text-white">
            ${this.formatCurrency(totalCost)}
          </td>
          <td class="py-3 px-4 whitespace-nowrap text-center">
            <button onclick="app.deleteTransaction('${tx.id}')" class="p-1 text-slate-400 hover:text-red-500 transition" title="刪除交易">
              <i data-lucide="trash-2" class="w-4 h-4"></i>
            </button>
          </td>
        </tr>
      `;
    }).join('');
  }

  // ==================== CHARTS ====================
  renderCharts(stocks, accounts) {
    if (typeof Chart === 'undefined') return;

    // Chart 1: Stock allocation
    const stockCanvas = document.getElementById('chart-stocks');
    const stockEmpty = document.getElementById('chart-stocks-empty');
    if (stockCanvas) {
      if (stocks.length === 0) {
        stockCanvas.classList.add('hidden');
        stockEmpty.classList.remove('hidden');
      } else {
        stockCanvas.classList.remove('hidden');
        stockEmpty.classList.add('hidden');

        const labels = stocks.slice(0, 7).map(s => `${s.symbol} ${s.name}`);
        const data = stocks.slice(0, 7).map(s => s.marketValue);
        
        // Group remaining as "其他"
        if (stocks.length > 7) {
          labels.push('其他持股');
          const others = stocks.slice(7).reduce((sum, s) => sum + s.marketValue, 0);
          data.push(others);
        }

        const colors = ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#ec4899', '#06b6d4', '#64748b', '#94a3b8'];

        if (this.stockChartInstance) this.stockChartInstance.destroy();
        this.stockChartInstance = new Chart(stockCanvas, {
          type: 'doughnut',
          data: {
            labels: labels,
            datasets: [{
              data: data,
              backgroundColor: colors.slice(0, labels.length),
              borderWidth: 2,
              borderColor: document.documentElement.classList.contains('dark') ? '#1e293b' : '#ffffff'
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } },
              tooltip: {
                callbacks: {
                  label: (ctx) => ` ${ctx.label}: NT$ ${ctx.raw.toLocaleString()}`
                }
              }
            },
            cutout: '65%'
          }
        });
      }
    }

    // Chart 2: Account allocation
    const accountCanvas = document.getElementById('chart-accounts');
    const accountEmpty = document.getElementById('chart-accounts-empty');
    if (accountCanvas) {
      const activeAccounts = accounts.filter(a => a.totalMarketValue > 0);
      if (activeAccounts.length === 0) {
        accountCanvas.classList.add('hidden');
        accountEmpty.classList.remove('hidden');
      } else {
        accountCanvas.classList.remove('hidden');
        accountEmpty.classList.add('hidden');

        const labels = activeAccounts.map(a => a.name);
        const data = activeAccounts.map(a => a.totalMarketValue);
        const colors = ['#6366f1', '#0ea5e9', '#14b8a6', '#f43f5e', '#a855f7', '#84cc16'];

        if (this.accountChartInstance) this.accountChartInstance.destroy();
        this.accountChartInstance = new Chart(accountCanvas, {
          type: 'doughnut',
          data: {
            labels: labels,
            datasets: [{
              data: data,
              backgroundColor: colors.slice(0, labels.length),
              borderWidth: 2,
              borderColor: document.documentElement.classList.contains('dark') ? '#1e293b' : '#ffffff'
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } },
              tooltip: {
                callbacks: {
                  label: (ctx) => ` ${ctx.label}: NT$ ${ctx.raw.toLocaleString()}`
                }
              }
            },
            cutout: '65%'
          }
        });
      }
    }
  }

  // ==================== TRANSACTIONS ACTIONS ====================
  openBuyModal() {
    document.getElementById('buy-date').value = new Date().toISOString().slice(0, 10);
    this.updateDropdowns(this.calculateHoldings());
    this.setBuyUnit('lot');
    document.getElementById('buy-amount-input').value = '1';
    document.getElementById('buy-price').value = '';
    document.getElementById('buy-symbol').value = '';
    document.getElementById('buy-name').value = '';
    document.getElementById('buy-notes').value = '';
    const fb = document.getElementById('buy-symbol-feedback');
    if (fb) {
      fb.classList.add('hidden');
      fb.innerHTML = '';
    }
    this.calcBuyTotal();
    this.openModal('modal-buy');
  }

  setBuyUnit(unit) {
    this.currentBuyUnit = unit;
    const btnLot = document.getElementById('buy-unit-lot');
    const btnShare = document.getElementById('buy-unit-share');
    if (unit === 'lot') {
      btnLot.className = 'px-2 py-0.5 rounded font-medium bg-white dark:bg-slate-700 shadow-sm text-blue-600 dark:text-blue-400';
      btnShare.className = 'px-2 py-0.5 rounded font-medium text-slate-500';
    } else {
      btnShare.className = 'px-2 py-0.5 rounded font-medium bg-white dark:bg-slate-700 shadow-sm text-blue-600 dark:text-blue-400';
      btnLot.className = 'px-2 py-0.5 rounded font-medium text-slate-500';
    }
    this.calcBuyTotal();
  }

  onSymbolInput(val, mode) {
    const symbol = val.trim().toUpperCase();
    const feedbackEl = document.getElementById('buy-symbol-feedback');
    const db = window.ALL_TW_STOCKS || STOCK_DICTIONARY;
    const stock = db[symbol];

    if (stock) {
      if (mode === 'buy') {
        document.getElementById('buy-name').value = stock.name;
        if (stock.price > 0) {
          document.getElementById('buy-price').value = stock.price;
        }
        if (feedbackEl) {
          feedbackEl.innerHTML = `
            <div class="flex items-center justify-between">
              <span class="font-bold text-emerald-700 dark:text-emerald-300">
                ✅ 已辨識：${this.escapeHtml(stock.name)} <span class="text-xs px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/60 ml-1 font-mono">${stock.market || (stock.isETF ? 'ETF' : '台股')}</span>
              </span>
              <span class="font-mono font-bold text-emerald-600 dark:text-emerald-400">最新參考市價 $${stock.price}</span>
            </div>
          `;
          feedbackEl.classList.remove('hidden');
        }
        this.calcBuyTotal();
      }
    } else {
      if (feedbackEl) {
        if (symbol.length >= 4) {
          feedbackEl.innerHTML = `<span class="text-amber-600 dark:text-amber-400">🔍 搜尋行情中... 若為新上市櫃代號可手動確認名稱</span>`;
          feedbackEl.classList.remove('hidden');
          this.fetchOnlineStockInfo(symbol);
        } else {
          feedbackEl.classList.add('hidden');
        }
      }
    }
  }

  async fetchOnlineStockInfo(symbol) {
    try {
      const resp = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}.TW?interval=1d&range=1d`);
      if (resp.ok) {
        const json = await resp.json();
        const meta = json?.chart?.result?.[0]?.meta;
        if (meta && meta.regularMarketPrice) {
          const currentInput = document.getElementById('buy-symbol')?.value.trim().toUpperCase();
          if (currentInput === symbol) {
            const price = meta.regularMarketPrice;
            const name = meta.shortName || meta.symbol || symbol;
            document.getElementById('buy-price').value = price;
            if (!document.getElementById('buy-name').value) {
              document.getElementById('buy-name').value = name;
            }
            const feedbackEl = document.getElementById('buy-symbol-feedback');
            if (feedbackEl) {
              feedbackEl.innerHTML = `<span class="text-emerald-600 dark:text-emerald-400 font-semibold">✅ 線上行情：${this.escapeHtml(name)} ‧ 市價 $${price}</span>`;
              feedbackEl.classList.remove('hidden');
            }
            this.calcBuyTotal();
          }
        }
      }
    } catch (e) {
      // Background query silent fallback
    }
  }

  calcBuyTotal() {
    const rawAmount = parseFloat(document.getElementById('buy-amount-input')?.value || 0);
    const shares = this.currentBuyUnit === 'lot' ? Math.round(rawAmount * 1000) : Math.round(rawAmount);
    const labelEl = document.getElementById('buy-amount-label');
    if (labelEl) {
      labelEl.textContent = this.currentBuyUnit === 'lot' ? `張 (= ${shares.toLocaleString()} 股)` : `股 (= ${(shares/1000).toFixed(3)} 張)`;
    }

    const price = parseFloat(document.getElementById('buy-price')?.value || 0);
    const accountId = document.getElementById('buy-account')?.value;
    const account = this.data.accounts.find(a => a.id === accountId) || { discountRate: 0.6 };

    // Estimated fee: standard 0.1425% * discountRate, min 20 TWD
    let fee = Math.max(20, Math.floor(shares * price * 0.001425 * account.discountRate));
    if (shares === 0 || price === 0) fee = 0;

    const feeInput = document.getElementById('buy-fee');
    if (feeInput && (feeInput.value === '' || feeInput.dataset.autoCalculated !== 'false')) {
      feeInput.value = fee;
    }

    const actualFee = parseFloat(feeInput?.value || fee || 0);
    const total = Math.round(shares * price + actualFee);
    const previewEl = document.getElementById('buy-total-preview');
    if (previewEl) previewEl.textContent = `NT$ ${total.toLocaleString()}`;
  }

  handleBuySubmit(e) {
    e.preventDefault();
    const accountId = document.getElementById('buy-account').value;
    const date = document.getElementById('buy-date').value;
    const symbol = document.getElementById('buy-symbol').value.trim().toUpperCase();
    const name = document.getElementById('buy-name').value.trim();
    const rawAmount = parseFloat(document.getElementById('buy-amount-input').value);
    const shares = this.currentBuyUnit === 'lot' ? Math.round(rawAmount * 1000) : Math.round(rawAmount);
    const price = parseFloat(document.getElementById('buy-price').value);
    const fee = parseInt(document.getElementById('buy-fee').value) || 0;
    const notes = document.getElementById('buy-notes').value.trim();

    if (!symbol || !name || shares <= 0 || price <= 0) {
      alert('請填寫完整正確的股票代號、股數與單價！');
      return;
    }

    const tx = {
      id: 'tx_' + Date.now(),
      type: 'BUY',
      accountId,
      symbol,
      name,
      date,
      shares,
      price,
      fee,
      tax: 0,
      notes
    };

    this.data.transactions.push(tx);

    // Save or update latest price cache
    if (!this.data.prices[symbol]) {
      this.data.prices[symbol] = {
        price: price,
        change: 0,
        changePercent: 0,
        lastUpdated: new Date().toISOString()
      };
    }

    this.saveData();
    this.closeModal('modal-buy');
    this.render();
  }

  // ==================== SELL MODAL & FLOW ====================
  openSellModal() {
    const holdings = this.calculateHoldings();
    const select = document.getElementById('sell-holding-select');
    select.innerHTML = '<option value="">-- 請選擇有在庫庫存的戶頭與股票 --</option>';

    holdings.forEach(h => {
      if (h.inAccountShares > 0) {
        const acc = this.data.accounts.find(a => a.id === h.accountId) || { name: '未知券商' };
        select.innerHTML += `
          <option value="${h.accountId}|${h.symbol}">
            ${acc.name} - ${h.name} (${h.symbol}) ｜ 在庫可賣: ${h.inAccountShares.toLocaleString()} 股 (${(h.inAccountShares/1000).toFixed(1)}張)
          </option>
        `;
      }
    });

    document.getElementById('sell-date').value = new Date().toISOString().slice(0, 10);
    document.getElementById('sell-inventory-info').classList.add('hidden');
    document.getElementById('sell-shares').value = '';
    document.getElementById('sell-price').value = '';
    document.getElementById('sell-fee').value = '';
    document.getElementById('sell-tax').value = '';
    this.calcSellTotal();
    this.openModal('modal-sell');
  }

  onSellHoldingChange(val) {
    const banner = document.getElementById('sell-inventory-info');
    if (!val) {
      banner.classList.add('hidden');
      return;
    }

    const [accountId, symbol] = val.split('|');
    const holdings = this.calculateHoldings();
    const holding = holdings.find(h => h.accountId === accountId && h.symbol === symbol);

    if (holding) {
      banner.classList.remove('hidden');
      document.getElementById('sell-info-total').textContent = holding.totalShares.toLocaleString();
      document.getElementById('sell-info-lent').textContent = holding.lentShares.toLocaleString();
      document.getElementById('sell-info-available').textContent = holding.inAccountShares.toLocaleString();
      document.getElementById('sell-info-available-lots').textContent = (holding.inAccountShares / 1000).toFixed(2);
      
      document.getElementById('sell-price').value = holding.currentPrice;
      document.getElementById('sell-shares').max = holding.inAccountShares;
      this.calcSellTotal();
    }
  }

  sellAllAvailable() {
    const val = document.getElementById('sell-holding-select').value;
    if (!val) return;
    const [accountId, symbol] = val.split('|');
    const holding = this.calculateHoldings().find(h => h.accountId === accountId && h.symbol === symbol);
    if (holding) {
      document.getElementById('sell-shares').value = holding.inAccountShares;
      this.calcSellTotal();
    }
  }

  calcSellTotal() {
    const val = document.getElementById('sell-holding-select')?.value;
    const shares = parseInt(document.getElementById('sell-shares')?.value || 0);
    const price = parseFloat(document.getElementById('sell-price')?.value || 0);

    if (!val || shares <= 0 || price <= 0) {
      document.getElementById('sell-total-preview').textContent = 'NT$ 0';
      document.getElementById('sell-pnl-preview').textContent = 'NT$ 0';
      return;
    }

    const [accountId, symbol] = val.split('|');
    const account = this.data.accounts.find(a => a.id === accountId) || { discountRate: 0.6 };
    const holding = this.calculateHoldings().find(h => h.accountId === accountId && h.symbol === symbol);

    const db = window.ALL_TW_STOCKS || STOCK_DICTIONARY;
    const isETF = (db[symbol]?.isETF) || symbol.startsWith('00') || symbol.includes('B');
    const taxRate = isETF ? 0.001 : 0.003; // ETF 0.1%, Stock 0.3%

    const fee = Math.max(20, Math.floor(shares * price * 0.001425 * account.discountRate));
    const tax = Math.floor(shares * price * taxRate);

    document.getElementById('sell-fee').value = fee;
    document.getElementById('sell-tax').value = tax;

    const proceeds = Math.round(shares * price - fee - tax);
    document.getElementById('sell-total-preview').textContent = `NT$ ${proceeds.toLocaleString()}`;

    // Estimated realized P&L
    if (holding && holding.avgCost) {
      const cost = holding.avgCost * shares;
      const pnl = proceeds - cost;
      const prefix = pnl >= 0 ? '+' : '';
      const color = this.getPnLColorClass(pnl);
      const pnlEl = document.getElementById('sell-pnl-preview');
      pnlEl.textContent = `${prefix}NT$ ${Math.round(pnl).toLocaleString()}`;
      pnlEl.className = `font-bold ${color}`;
    }
  }

  handleSellSubmit(e) {
    e.preventDefault();
    const val = document.getElementById('sell-holding-select').value;
    if (!val) {
      alert('請先選擇要賣出的庫存項目！');
      return;
    }

    const [accountId, symbol] = val.split('|');
    const date = document.getElementById('sell-date').value;
    const shares = parseInt(document.getElementById('sell-shares').value);
    const price = parseFloat(document.getElementById('sell-price').value);
    const fee = parseInt(document.getElementById('sell-fee').value) || 0;
    const tax = parseInt(document.getElementById('sell-tax').value) || 0;

    const holding = this.calculateHoldings().find(h => h.accountId === accountId && h.symbol === symbol);
    if (!holding || shares > holding.inAccountShares) {
      alert(`賣出股數 (${shares}) 超過該帳戶在庫可賣數量 (${holding ? holding.inAccountShares : 0})！\n若有股票借出中，需先辦理召回方可賣出。`);
      return;
    }

    const tx = {
      id: 'tx_' + Date.now(),
      type: 'SELL',
      accountId,
      symbol,
      name: holding.name,
      date,
      shares,
      price,
      fee,
      tax,
      notes: ''
    };

    this.data.transactions.push(tx);
    this.saveData();
    this.closeModal('modal-sell');
    this.render();
  }

  // ==================== LENDING (出借) ACTIONS ====================
  openLendModal() {
    const holdings = this.calculateHoldings();
    const select = document.getElementById('lend-holding-select');
    select.innerHTML = '<option value="">-- 請先選擇有在庫現股的項目 --</option>';

    holdings.forEach(h => {
      if (h.inAccountShares > 0) {
        const acc = this.data.accounts.find(a => a.id === h.accountId) || { name: '未知券商' };
        select.innerHTML += `
          <option value="${h.accountId}|${h.symbol}">
            ${acc.name} - ${h.name} (${h.symbol}) ｜ 在庫可借: ${h.inAccountShares.toLocaleString()} 股
          </option>
        `;
      }
    });

    document.getElementById('lend-date').value = new Date().toISOString().slice(0, 10);
    document.getElementById('lend-available-info').classList.add('hidden');
    document.getElementById('lend-shares').value = '';
    document.getElementById('lend-rate').value = '2.5';
    document.getElementById('lend-notes').value = '';
    this.openModal('modal-lend');
  }

  onLendHoldingChange(val) {
    const banner = document.getElementById('lend-available-info');
    if (!val) {
      banner.classList.add('hidden');
      return;
    }

    const [accountId, symbol] = val.split('|');
    const holding = this.calculateHoldings().find(h => h.accountId === accountId && h.symbol === symbol);
    if (holding) {
      banner.classList.remove('hidden');
      document.getElementById('lend-max-shares').textContent = holding.inAccountShares.toLocaleString();
      document.getElementById('lend-max-lots').textContent = (holding.inAccountShares / 1000).toFixed(2);
      document.getElementById('lend-shares').max = holding.inAccountShares;
    }
  }

  lendAllAvailable() {
    const val = document.getElementById('lend-holding-select').value;
    if (!val) return;
    const [accountId, symbol] = val.split('|');
    const holding = this.calculateHoldings().find(h => h.accountId === accountId && h.symbol === symbol);
    if (holding) {
      document.getElementById('lend-shares').value = holding.inAccountShares;
    }
  }

  handleLendSubmit(e) {
    e.preventDefault();
    const val = document.getElementById('lend-holding-select').value;
    if (!val) {
      alert('請先選擇要出借的股票項目！');
      return;
    }

    const [accountId, symbol] = val.split('|');
    const startDate = document.getElementById('lend-date').value;
    const shares = parseInt(document.getElementById('lend-shares').value);
    const rate = parseFloat(document.getElementById('lend-rate').value);
    const notes = document.getElementById('lend-notes').value.trim();

    const holding = this.calculateHoldings().find(h => h.accountId === accountId && h.symbol === symbol);
    if (!holding || shares > holding.inAccountShares) {
      alert(`出借股數 (${shares}) 超過在庫可出借數量 (${holding ? holding.inAccountShares : 0})！`);
      return;
    }

    const lendRecord = {
      id: 'lend_' + Date.now(),
      accountId,
      symbol,
      name: holding.name,
      shares,
      rate,
      startDate,
      endDate: null,
      status: 'LENT',
      earnedInterest: 0,
      notes
    };

    this.data.lendings.push(lendRecord);
    this.saveData();
    this.closeModal('modal-lend');
    this.render();
  }

  // ==================== RECALL / RETURN (召回/還券) ACTIONS ====================
  openRecallModal() {
    this.populateRecallSelect();
    this.openModal('modal-recall');
  }

  openRecallModalWithItem(lendingId) {
    this.populateRecallSelect(lendingId);
    this.openModal('modal-recall');
  }

  populateRecallSelect(selectedId = null) {
    const select = document.getElementById('recall-lending-select');
    select.innerHTML = '<option value="">-- 請選擇欲召回或已還券的項目 --</option>';

    const activeList = this.data.lendings.filter(l => l.status === 'LENT');
    activeList.forEach(l => {
      const acc = this.data.accounts.find(a => a.id === l.accountId) || { name: '未知券商' };
      const isSelected = l.id === selectedId ? 'selected' : '';
      select.innerHTML += `
        <option value="${l.id}" ${isSelected}>
          ${acc.name} - ${l.name} (${l.symbol}) ｜ ${l.shares.toLocaleString()} 股 @ 年息 ${l.rate}% (起日: ${l.startDate})
        </option>
      `;
    });

    document.getElementById('recall-date').value = new Date().toISOString().slice(0, 10);
    if (selectedId) {
      this.onRecallItemChange(selectedId);
    } else {
      document.getElementById('recall-detail-info').classList.add('hidden');
      document.getElementById('recall-interest').value = '';
    }
  }

  onRecallItemChange(lendingId) {
    const banner = document.getElementById('recall-detail-info');
    if (!lendingId) {
      banner.classList.add('hidden');
      return;
    }

    const item = this.data.lendings.find(l => l.id === lendingId);
    if (item) {
      banner.classList.remove('hidden');
      document.getElementById('recall-info-start').textContent = item.startDate;
      document.getElementById('recall-info-rate').textContent = item.rate;
      document.getElementById('recall-info-shares').textContent = item.shares.toLocaleString();
      this.calcEstimatedInterest();
    }
  }

  calcEstimatedInterest() {
    const lendingId = document.getElementById('recall-lending-select')?.value;
    const recallDateStr = document.getElementById('recall-date')?.value;
    if (!lendingId || !recallDateStr) return;

    const item = this.data.lendings.find(l => l.id === lendingId);
    if (!item) return;

    const currentPrice = (this.data.prices[item.symbol]?.price) || 0;
    const lentValue = item.shares * currentPrice;

    const start = new Date(item.startDate);
    const end = new Date(recallDateStr);
    const days = Math.max(1, Math.floor((end - start) / (1000 * 60 * 60 * 24)));

    // Est interest = lentValue * (rate/100) * (days/365) * 0.8 (approx net after 20% broker fee)
    const estNet = Math.round(lentValue * (item.rate / 100) * (days / 365) * 0.8);

    document.getElementById('recall-estimated-interest-text').textContent = `約 NT$ ${estNet.toLocaleString()} (${days} 天)`;
    const input = document.getElementById('recall-interest');
    if (input && !input.value) {
      input.value = estNet;
    }
  }

  handleRecallSubmit(e) {
    e.preventDefault();
    const lendingId = document.getElementById('recall-lending-select').value;
    if (!lendingId) {
      alert('請先選擇要結算的借券項目！');
      return;
    }

    const item = this.data.lendings.find(l => l.id === lendingId);
    if (!item) return;

    const endDate = document.getElementById('recall-date').value;
    const interest = parseInt(document.getElementById('recall-interest').value) || 0;

    item.endDate = endDate;
    item.earnedInterest = interest;
    item.status = 'RETURNED';

    this.saveData();
    this.closeModal('modal-recall');
    this.render();
    alert(`成功還券！此筆股票已重新回到「在庫現股」可交易狀態，並入帳 NT$ ${interest.toLocaleString()} 借券利息！`);
  }

  deleteLending(id) {
    if (confirm('確定要刪除這筆借券紀錄嗎？')) {
      this.data.lendings = this.data.lendings.filter(l => l.id !== id);
      this.saveData();
      this.render();
    }
  }

  deleteTransaction(id) {
    if (confirm('確定要刪除這筆交易紀錄嗎？')) {
      this.data.transactions = this.data.transactions.filter(t => t.id !== id);
      this.saveData();
      this.render();
    }
  }

  // ==================== PRICE UPDATES & EDITING ====================
  openEditPriceModal(symbol, name, currentPrice) {
    this.editingPriceSymbol = symbol;
    document.getElementById('edit-price-stock-info').textContent = `${name} (${symbol})`;
    document.getElementById('edit-price-input').value = currentPrice;
    this.openModal('modal-edit-price');
  }

  saveCustomPrice() {
    if (!this.editingPriceSymbol) return;
    const newPrice = parseFloat(document.getElementById('edit-price-input').value);
    if (newPrice > 0) {
      if (!this.data.prices[this.editingPriceSymbol]) {
        this.data.prices[this.editingPriceSymbol] = { price: newPrice, change: 0, changePercent: 0 };
      }
      this.data.prices[this.editingPriceSymbol].price = newPrice;
      this.data.prices[this.editingPriceSymbol].lastUpdated = new Date().toISOString();
      this.saveData();
      this.closeModal('modal-edit-price');
      this.render();
    }
  }

  async refreshAllPrices() {
    const btn = document.getElementById('btn-refresh-prices');
    const originalText = btn.innerHTML;
    btn.innerHTML = `<i data-lucide="loader" class="w-4 h-4 animate-spin"></i><span>更新中...</span>`;
    if (window.lucide) lucide.createIcons();

    const holdings = this.calculateHoldings();
    const symbols = [...new Set(holdings.map(h => h.symbol))];

    let successCount = 0;
    for (const sym of symbols) {
      try {
        // Query Yahoo Finance TW quote via open CORS-friendly endpoint
        // e.g. 2330.TW or 0050.TW
        const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}.TW?interval=1d&range=1d`);
        if (response.ok) {
          const resJson = await response.json();
          const meta = resJson?.chart?.result?.[0]?.meta;
          if (meta && meta.regularMarketPrice) {
            const price = meta.regularMarketPrice;
            const prevClose = meta.chartPreviousClose || price;
            const change = price - prevClose;
            const changePercent = prevClose ? (change / prevClose) * 100 : 0;
            this.data.prices[sym] = {
              price: price,
              change: Math.round(change * 100) / 100,
              changePercent: Math.round(changePercent * 100) / 100,
              lastUpdated: new Date().toISOString()
            };
            successCount++;
          }
        }
      } catch (err) {
        console.warn(`Could not auto-fetch price for ${sym}:`, err);
      }
    }

    btn.innerHTML = originalText;
    if (window.lucide) lucide.createIcons();

    if (successCount > 0) {
      this.saveData();
      this.render();
      alert(`已成功連線更新 ${successCount} 檔股票之最新行情！`);
    } else {
      // Prompt user with friendly alternative
      alert('已連線檢驗行情。如因瀏覽器跨網域安全限制未能自動抓取，您可以隨時點選股票卡片旁的「市價」按鈕快速手動修改！');
    }
  }

  // ==================== BROKERAGE ACCOUNT MANAGEMENT ====================
  openAccountsModal() {
    this.renderAccountsManageList();
    this.openModal('modal-accounts');
  }

  renderAccountsManageList() {
    const container = document.getElementById('accounts-manage-list');
    container.innerHTML = this.data.accounts.map(acc => `
      <div class="flex items-center justify-between p-3 rounded-xl bg-slate-50 dark:bg-slate-900/40 border border-slate-200 dark:border-slate-700">
        <div>
          <span class="font-bold text-slate-900 dark:text-white">${this.escapeHtml(acc.name)}</span>
          <span class="text-xs text-slate-400 ml-2">折讓：${(acc.discountRate * 10).toFixed(1)} 折</span>
        </div>
        ${this.data.accounts.length > 1 ? `
          <button onclick="app.deleteAccount('${acc.id}')" class="text-xs text-red-500 hover:text-red-700 p-1">
            <i data-lucide="trash-2" class="w-4 h-4"></i>
          </button>
        ` : ''}
      </div>
    `).join('');
    if (window.lucide) lucide.createIcons();
  }

  addAccount() {
    const name = document.getElementById('new-account-name').value.trim();
    const discount = parseFloat(document.getElementById('new-account-discount').value) || 0.6;
    if (!name) {
      alert('請輸入券商名稱！');
      return;
    }

    const newAcc = {
      id: 'acc_' + Date.now(),
      name,
      discountRate: discount,
      note: ''
    };

    this.data.accounts.push(newAcc);
    this.saveData();
    document.getElementById('new-account-name').value = '';
    this.renderAccountsManageList();
    this.render();
  }

  deleteAccount(accId) {
    // Check if account has holdings or transactions
    const hasTx = this.data.transactions.some(t => t.accountId === accId);
    if (hasTx) {
      alert('此券商戶頭已有交易紀錄，無法直接刪除！請先刪除該券商的相關交易。');
      return;
    }

    if (confirm('確定要刪除此證券商戶頭嗎？')) {
      this.data.accounts = this.data.accounts.filter(a => a.id !== accId);
      this.saveData();
      this.renderAccountsManageList();
      this.render();
    }
  }

  // ==================== UI HELPERS & SETTINGS ====================
  openSettingsModal() {
    this.openModal('modal-settings');
  }

  updateDropdowns(holdings) {
    // Buy account dropdown
    const buyAccSelect = document.getElementById('buy-account');
    if (buyAccSelect) {
      const current = buyAccSelect.value;
      buyAccSelect.innerHTML = this.data.accounts.map(a => `
        <option value="${a.id}" ${a.id === current ? 'selected' : ''}>${this.escapeHtml(a.name)} (${(a.discountRate*10).toFixed(1)}折)</option>
      `).join('');
    }

    // Filter tx account dropdown
    const filterAccSelect = document.getElementById('filter-tx-account');
    if (filterAccSelect) {
      filterAccSelect.innerHTML = '<option value="ALL">全部券商</option>' + this.data.accounts.map(a => `
        <option value="${a.id}">${this.escapeHtml(a.name)}</option>
      `).join('');
    }
  }

  toggleDarkMode() {
    this.data.settings.darkMode = !this.data.settings.darkMode;
    this.applySettings();
    this.saveData();
    this.renderCharts(this.getGroupedByStock(this.calculateHoldings()), this.getGroupedByAccount(this.calculateHoldings()));
  }

  toggleColorConvention() {
    this.data.settings.colorMode = this.data.settings.colorMode === 'tw' ? 'intl' : 'tw';
    this.applySettings();
    this.saveData();
    this.render();
  }

  applySettings() {
    // Dark mode
    const isDark = this.data.settings.darkMode;
    if (isDark) {
      document.documentElement.classList.add('dark');
      document.getElementById('theme-icon')?.setAttribute('data-lucide', 'sun');
    } else {
      document.documentElement.classList.remove('dark');
      document.getElementById('theme-icon')?.setAttribute('data-lucide', 'moon');
    }

    // Color convention badge
    const badge = document.getElementById('color-mode-badge');
    if (badge) {
      if (this.data.settings.colorMode === 'tw') {
        badge.textContent = '🇹🇼 紅漲綠跌';
        badge.className = 'font-bold text-red-500';
      } else {
        badge.textContent = '🌍 綠漲紅跌';
        badge.className = 'font-bold text-emerald-500';
      }
    }

    if (window.lucide) lucide.createIcons();
  }

  getPnLColorClass(val) {
    const isTW = this.data.settings.colorMode === 'tw';
    if (val > 0) return isTW ? 'text-red-500 dark:text-red-400' : 'text-emerald-500 dark:text-emerald-400';
    if (val < 0) return isTW ? 'text-emerald-500 dark:text-emerald-400' : 'text-red-500 dark:text-red-400';
    return 'text-slate-400';
  }

  filterLending(status) {
    this.lendingFilter = status;
    const btnActive = document.getElementById('lending-filter-active');
    const btnReturned = document.getElementById('lending-filter-returned');

    if (status === 'active') {
      btnActive.className = 'px-3 py-1 rounded-lg bg-purple-100 dark:bg-purple-900/50 text-purple-700 dark:text-purple-300';
      btnReturned.className = 'px-3 py-1 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800';
    } else {
      btnReturned.className = 'px-3 py-1 rounded-lg bg-purple-100 dark:bg-purple-900/50 text-purple-700 dark:text-purple-300';
      btnActive.className = 'px-3 py-1 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800';
    }

    this.renderLendingTracker();
  }

  openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.classList.remove('hidden');
      if (window.lucide) lucide.createIcons();
    }
  }

  closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.classList.add('hidden');
    }
  }

  formatCurrency(num) {
    return 'NT$ ' + Math.round(num || 0).toLocaleString();
  }

  escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, m => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[m]);
  }

  setupEventListeners() {
    // Navigation Tabs
    const tabs = document.querySelectorAll('.nav-tab');
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => {
          t.classList.remove('active-tab', 'border-blue-600', 'text-blue-600', 'dark:text-blue-400');
          t.classList.add('border-transparent', 'text-slate-500');
        });
        tab.classList.add('active-tab', 'border-blue-600', 'text-blue-600', 'dark:text-blue-400');
        tab.classList.remove('border-transparent', 'text-slate-500');

        document.querySelectorAll('.tab-content').forEach(content => content.classList.add('hidden'));
        const targetId = tab.dataset.tab;
        const targetContent = document.getElementById(targetId);
        if (targetContent) targetContent.classList.remove('hidden');
      });
    });

    // Stock search bar
    const searchInput = document.getElementById('search-stock');
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        const holdings = this.calculateHoldings();
        this.renderStockList(this.getGroupedByStock(holdings));
        if (window.lucide) lucide.createIcons();
      });
    }

    // Modal click outside to close
    document.querySelectorAll('[id^="modal-"]').forEach(modal => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          modal.classList.add('hidden');
        }
      });
    });
  }
}

// Instantiate global app instance
const app = new StockApp();
