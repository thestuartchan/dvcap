// lib/companyNames.js — ticker → the name a human uses.
//
// WHY IT MOVED HERE. This map lived inside src/App.jsx, where only the dashboard could reach it, so
// the trade console rendered bare tickers beside the same instruments the dashboard named. One map
// in one place, imported by both, rather than a second copy that drifts.
//
// It is DELIBERATELY PARTIAL. No quote feed this project uses returns a company name, so every
// entry here is hand-written and covers what has actually been held or watched. A ticker with no
// entry renders as the bare ticker, which is what it did everywhere before — a missing name must
// never become an empty gap or a guessed one.

export const COMPANY_NAMES = {
  AAPL:"Apple", AXP:"American Express", KO:"Coca-Cola", BAC:"Bank of America",
  CVX:"Chevron", OXY:"Occidental Petroleum", GOOGL:"Alphabet (Google)",
  CB:"Chubb", MCO:"Moody's", DAL:"Delta Air Lines", BN:"Brookfield Asset Mgmt",
  AMZN:"Amazon", UBER:"Uber", MSFT:"Microsoft", QSR:"Restaurant Brands",
  HHH:"Howard Hughes", FNMA:"Fannie Mae", SPY:"S&P 500 ETF", IVV:"iShares S&P 500",
  NVDA:"Nvidia", AVGO:"Broadcom", MU:"Micron Technology", ORCL:"Oracle",
  TSM:"Taiwan Semiconductor", NTRA:"Natera", ETHB:"Ethereum ETF",
  INSM:"Insmed", EWZ:"Brazil ETF", ARGT:"Argentina ETF", SNDK:"SanDisk",
  HUM:"Humana", "JD.com":"JD.com", INTC:"Intel", HOOD:"Robinhood",
  BABA:"Alibaba", META:"Meta Platforms", CRWD:"CrowdStrike", W:"Wayfair",
  GDX:"Gold Miners ETF", GDXJ:"Junior Gold Miners ETF", RING:"Global Gold Miners ETF",
  AEM:"Agnico Eagle", NEM:"Newmont", ABX:"Barrick Mining", WPM:"Wheaton Precious Metals",
  XLP:"Consumer Staples ETF", PG:"Procter & Gamble", PEP:"PepsiCo",
  WMT:"Walmart", COST:"Costco", MDLZ:"Mondelez",
  TLT:"20+ Year Treasury ETF", IEF:"7-10 Year Treasury ETF",
  ZROZ:"25+ Zero Coupon ETF", BIL:"1-3 Month T-Bill ETF",
  LAND:"Gladstone Land", FPI:"Farmland Partners",
  EPD:"Enterprise Products", ET:"Energy Transfer", MPLX:"MPLX LP",
  KMI:"Kinder Morgan", AMLP:"Alerian MLP ETF",
  O:"Realty Income", NNN:"NNN REIT", WPC:"W.P. Carey", STAG:"STAG Industrial",
  JNJ:"Johnson & Johnson", SCHD:"Schwab Dividend ETF", VIG:"Vanguard Div. Appreciation",
  JEPI:"JPMorgan Equity Premium", JEPQ:"JPMorgan Nasdaq Premium",
  XYLD:"Global X S&P 500 Covered Call", PFF:"iShares Preferred Securities",
  PFFD:"Global X Preferred ETF", SGOV:"0-3 Month T-Bill ETF",
  USFR:"WisdomTree Floating Rate Treasury", ARM:"ARM Holdings",
  SE:"Sea Ltd", GEV:"GE Vernova", LRCX:"Lam Research", SPOT:"Spotify",
  CPNG:"Coupang", AMAT:"Applied Materials", CPAY:"Corpay", GOOG:"Alphabet (Google)",
  VST:"Vistra", EWY:"South Korea ETF", NRG:"NRG Energy", GLW:"Corning", WHR:"Whirlpool",
  CRM:"Salesforce", ADBE:"Adobe", BKNG:"Booking Holdings", AMD:"Adv. Micro Devices",
  RSP:"S&P 500 Equal-Weight ETF", YPF:"YPF SA", WWD:"Woodward", TEVA:"Teva Pharma",
  CAI:"Caris Life Sciences", STX:"Seagate Technology",
  "EUROB.AT":"Eurobank Ergasias (Greece)", FFXDF:"Fairfax India Holdings",
  KW:"Kennedy-Wilson", BB:"BlackBerry", ORLA:"Orla Mining",
  FRFHF:"Fairfax Financial (buybacks)", CIBEY:"Commercial Int'l Bank (Egypt)",
  "DXT.TO":"Dexterra Group",
  Other:"Various",
};

// The name if we have one, otherwise null — never the ticker itself, so the caller decides whether
// a bare ticker is the right fallback for its layout.
export function companyName(ticker) {
  if (!ticker) return null;
  return COMPANY_NAMES[String(ticker)] ?? COMPANY_NAMES[String(ticker).toUpperCase()] ?? null;
}
