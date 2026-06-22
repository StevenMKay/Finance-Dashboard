/* TradingView widget mounters.
 * All widgets are loaded via the official embed pattern: a container <div>
 * with a child <script src="..."> whose innerText is the widget config JSON.
 */
(function () {
  function setWidget(containerId, scriptSrc, config) {
    var host = document.getElementById(containerId);
    if (!host) return;
    host.innerHTML = '';
    var inner = document.createElement('div');
    inner.className = 'tradingview-widget-container__widget';
    host.appendChild(inner);
    var s = document.createElement('script');
    s.type = 'text/javascript';
    s.src = scriptSrc;
    s.async = true;
    s.innerHTML = JSON.stringify(config);
    host.appendChild(s);
  }

  function tickerTape(containerId, symbols) {
    var arr = (symbols || []).map(function (s) {
      return { description: s, proName: s };
    });
    if (!arr.length) {
      arr = [
        { description: 'S&P 500', proName: 'AMEX:SPY' },
        { description: 'Nasdaq', proName: 'NASDAQ:QQQ' },
        { description: 'Dow',    proName: 'AMEX:DIA' }
      ];
    }
    setWidget(containerId, 'https://s3.tradingview.com/external-embedding/embed-widget-ticker-tape.js', {
      symbols: arr,
      showSymbolLogo: true,
      isTransparent: false,
      displayMode: 'adaptive',
      colorTheme: 'dark',
      locale: 'en'
    });
  }

  function symbolOverview(containerId, symbol) {
    setWidget(containerId, 'https://s3.tradingview.com/external-embedding/embed-widget-symbol-overview.js', {
      symbols: [[symbol, symbol + '|1D']],
      chartOnly: false,
      width: '100%',
      height: 360,
      locale: 'en',
      colorTheme: 'light',
      autosize: true,
      showVolume: true,
      hideDateRanges: false,
      scalePosition: 'right',
      scaleMode: 'Normal',
      fontFamily: 'Segoe UI, sans-serif',
      lineWidth: 2
    });
  }

  function timeline(containerId, symbol) {
    setWidget(containerId, 'https://s3.tradingview.com/external-embedding/embed-widget-timeline.js', {
      feedMode: 'symbol',
      symbol: symbol,
      colorTheme: 'light',
      isTransparent: false,
      displayMode: 'regular',
      width: '100%',
      height: 360,
      locale: 'en'
    });
  }

  function marketOverview(containerId) {
    setWidget(containerId, 'https://s3.tradingview.com/external-embedding/embed-widget-market-overview.js', {
      colorTheme: 'light',
      dateRange: '12M',
      showChart: true,
      locale: 'en',
      largeChartUrl: '',
      isTransparent: false,
      showSymbolLogo: true,
      showFloatingTooltip: false,
      width: '100%',
      height: 460,
      plotLineColorGrowing: '#27ae60',
      plotLineColorFalling: '#e74c3c',
      gridLineColor: 'rgba(0, 0, 0, 0.06)',
      scaleFontColor: '#4a5568',
      belowLineFillColorGrowing: 'rgba(39, 174, 96, 0.12)',
      belowLineFillColorFalling: 'rgba(231, 76, 60, 0.12)',
      tabs: [
        { title: 'Indices', symbols: [
          { s: 'FOREXCOM:SPXUSD', d: 'S&P 500' },
          { s: 'FOREXCOM:NSXUSD', d: 'Nasdaq 100' },
          { s: 'FOREXCOM:DJI',    d: 'Dow 30' },
          { s: 'INDEX:VIX',       d: 'Volatility' }
        ], originalTitle: 'Indices' },
        { title: 'Tech', symbols: [
          { s: 'NASDAQ:AAPL' }, { s: 'NASDAQ:MSFT' }, { s: 'NASDAQ:GOOGL' },
          { s: 'NASDAQ:AMZN' }, { s: 'NASDAQ:META' }, { s: 'NASDAQ:NVDA' }
        ], originalTitle: 'Tech' }
      ]
    });
  }

  window.FinanceTV = {
    tickerTape: tickerTape,
    symbolOverview: symbolOverview,
    timeline: timeline,
    marketOverview: marketOverview
  };
})();
