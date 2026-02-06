/**
 * Mock Price Server for E2E Testing
 *
 * Serves hardcoded prices for bilateral E2E tests.
 * Both bots will get identical prices, enabling happy path settlement.
 */

import { serve } from "bun";

const PORT = parseInt(process.env.MOCK_PRICE_PORT || "4000", 10);

// Generate 250 mock stocks with deterministic prices
// Mix of up/down movements for realistic testing
const STOCK_TICKERS = [
  // Major tech (10)
  "AAPL", "MSFT", "GOOGL", "AMZN", "META", "NVDA", "TSLA", "AMD", "INTC", "CRM",
  // More tech (20)
  "ORCL", "ADBE", "NFLX", "PYPL", "UBER", "LYFT", "SNAP", "PINS", "SQ", "SHOP",
  "TWLO", "ZM", "DOCU", "OKTA", "CRWD", "NET", "DDOG", "MDB", "SNOW", "PLTR",
  // Finance (20)
  "JPM", "BAC", "WFC", "GS", "MS", "C", "BLK", "SCHW", "AXP", "V",
  "MA", "COF", "DFS", "SYF", "ALLY", "USB", "PNC", "TFC", "KEY", "FITB",
  // Healthcare (20)
  "JNJ", "UNH", "PFE", "ABBV", "MRK", "TMO", "ABT", "DHR", "BMY", "LLY",
  "AMGN", "GILD", "REGN", "VRTX", "BIIB", "ILMN", "ISRG", "EW", "SYK", "BDX",
  // Consumer (20)
  "WMT", "COST", "TGT", "HD", "LOW", "NKE", "SBUX", "MCD", "YUM", "CMG",
  "DPZ", "LULU", "ROST", "TJX", "DG", "DLTR", "KR", "WBA", "CVS", "ULTA",
  // Industrial (20)
  "CAT", "DE", "MMM", "HON", "GE", "BA", "LMT", "RTX", "NOC", "GD",
  "UPS", "FDX", "CSX", "UNP", "NSC", "EMR", "ROK", "ETN", "PH", "ITW",
  // Energy (15)
  "XOM", "CVX", "COP", "EOG", "SLB", "MPC", "VLO", "PSX", "OXY", "DVN",
  "HAL", "BKR", "FANG", "PXD", "HES",
  // Materials (15)
  "LIN", "APD", "SHW", "ECL", "DD", "DOW", "NEM", "FCX", "NUE", "STLD",
  "CLF", "AA", "X", "CF", "MOS",
  // Utilities (10)
  "NEE", "DUK", "SO", "D", "AEP", "EXC", "SRE", "PEG", "ED", "XEL",
  // Real Estate (10)
  "AMT", "PLD", "CCI", "EQIX", "PSA", "SPG", "O", "WELL", "AVB", "EQR",
  // Communications (15)
  "T", "VZ", "TMUS", "CMCSA", "DIS", "NFLX", "WBD", "PARA", "FOX", "FOXA",
  "CHTR", "LBRDK", "DISH", "LYV", "MTCH",
  // Additional tech (25)
  "NOW", "WDAY", "TEAM", "HUBS", "VEEV", "SPLK", "ANSS", "CDNS", "SNPS", "KLAC",
  "LRCX", "AMAT", "ASML", "TXN", "ADI", "MCHP", "NXPI", "QCOM", "AVGO", "MU",
  "WDC", "STX", "HPQ", "DELL", "HPE",
  // Additional consumer (25)
  "PG", "KO", "PEP", "MDLZ", "KHC", "GIS", "K", "CAG", "SJM", "CPB",
  "HSY", "MKC", "HRL", "TSN", "CAH", "MCK", "ABC", "CI", "HUM", "CNC",
  "ELV", "MOH", "ANTM", "UHS", "HCA",
  // Additional finance (20)
  "BRK.B", "CB", "AON", "MMC", "AJG", "WTW", "BRO", "AFL", "MET", "PRU",
  "LNC", "VOYA", "GL", "UNM", "RGA", "AIG", "ALL", "TRV", "PGR", "HIG",
  // Additional industrial (15)
  "WM", "RSG", "VRSK", "CPRT", "FAST", "ODFL", "JBHT", "EXPD", "CHRW", "XPO",
  "GWW", "POOL", "SNA", "SWK", "WSO",
  // Misc (10)
  "BKNG", "EXPE", "MAR", "HLT", "H", "WYNN", "LVS", "MGM", "CZR", "PENN"
];

// Generate deterministic prices - ~55% will go up, ~45% will go down for realistic bet outcomes
function generateMockPrices(): Record<string, { entry: bigint; exit: bigint }> {
  const prices: Record<string, { entry: bigint; exit: bigint }> = {};

  for (let i = 0; i < STOCK_TICKERS.length; i++) {
    const ticker = STOCK_TICKERS[i];
    // Base price between 50 and 500 (in cents * 100 for precision)
    const basePrice = BigInt(5000 + (i * 137) % 45000);

    // Deterministic change: use index to decide direction
    // Pattern: alternating with some randomness based on index
    const goesUp = (i % 3 !== 0) || (i % 7 === 0); // ~60% go up
    const changePct = ((i * 17) % 800) + 50; // 0.5% to 8.5% change

    let exitPrice: bigint;
    if (goesUp) {
      exitPrice = basePrice + (basePrice * BigInt(changePct)) / 10000n;
    } else {
      exitPrice = basePrice - (basePrice * BigInt(changePct)) / 10000n;
    }

    prices[ticker] = { entry: basePrice, exit: exitPrice };
  }

  return prices;
}

const MOCK_PRICES = generateMockPrices();

// Track which price mode we're in (entry vs exit)
let currentMode: "entry" | "exit" = "entry";

const server = serve({
  port: PORT,
  fetch: async (req) => {
    const url = new URL(req.url);

    // Health check
    if (url.pathname === "/health") {
      return Response.json({ status: "healthy", mode: currentMode });
    }

    // Set price mode (for simulating time passage)
    if (url.pathname === "/api/set-mode" && req.method === "POST") {
      const body = await req.json() as { mode: "entry" | "exit" };
      currentMode = body.mode;
      console.log(`[MockPriceServer] Mode set to: ${currentMode}`);
      return Response.json({ mode: currentMode });
    }

    // Latest snapshot
    if (url.pathname === "/api/snapshots/latest") {
      const source = url.searchParams.get("source") || "stocks";
      const prices = Object.entries(MOCK_PRICES).map(([ticker, p]) => ({
        ticker,
        price: (currentMode === "entry" ? p.entry : p.exit).toString(),
      }));

      return Response.json({
        snapshotId: `${source}-mock-${Date.now()}`,
        prices,
        timestamp: Math.floor(Date.now() / 1000),
      });
    }

    // Individual price lookup
    if (url.pathname.startsWith("/api/prices/")) {
      const parts = url.pathname.split("/");
      const ticker = parts[parts.length - 1].toUpperCase();
      const mockPrice = MOCK_PRICES[ticker];

      if (mockPrice) {
        const price = currentMode === "entry" ? mockPrice.entry : mockPrice.exit;
        return Response.json({ ticker, price: price.toString() });
      }

      return Response.json({ error: "Ticker not found" }, { status: 404 });
    }

    // Resolve endpoint (for keepers)
    if (url.pathname === "/api/resolve" && req.method === "POST") {
      const body = await req.json() as { betId: number; trades: any[] };
      // Keepers use exit prices for resolution
      const exitPrices = Object.entries(MOCK_PRICES).reduce((acc, [ticker, p]) => {
        acc[ticker] = p.exit.toString();
        return acc;
      }, {} as Record<string, string>);

      return Response.json({
        betId: body.betId,
        exitPrices,
        timestamp: Math.floor(Date.now() / 1000),
      });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

console.log(`[MockPriceServer] Started on port ${PORT}`);
console.log(`[MockPriceServer] Available tickers: ${Object.keys(MOCK_PRICES).join(", ")}`);
console.log(`[MockPriceServer] Current mode: ${currentMode}`);
console.log(`[MockPriceServer] To switch to exit prices: curl -X POST http://localhost:${PORT}/api/set-mode -d '{"mode":"exit"}'`);
