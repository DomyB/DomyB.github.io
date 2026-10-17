"""Extra symbols the model learns from but the page doesn't show.

A model that ranks stocks against each other gets better the more stocks it
sees, so besides the tracked list in _data/stocks.yml the training set includes
these large, liquid US names. They cost nothing on the page: only the tracked
symbols are written out.
"""

TRAINING_ONLY = [
    # Technology
    "ACN", "TXN", "AMAT", "MU", "LRCX", "ADI", "KLAC", "NOW", "INTU", "PANW", "SNPS", "CDNS",
    "ANET", "MRVL", "ADP", "PYPL", "FTNT", "CTSH", "HPQ", "DELL", "GLW", "APH",
    # Communication
    "TMUS", "CHTR", "EA", "TTWO", "WBD", "OMC",
    # Finance
    "C", "SCHW", "USB", "PNC", "TFC", "COF", "CB", "PGR", "MMC", "AON", "SPGI", "MCO", "ICE",
    "CME", "AIG", "MET", "PRU", "BK", "AFL", "ALL", "TRV",
    # Health
    "AMGN", "GILD", "BMY", "CVS", "CI", "ELV", "HUM", "ISRG", "MDT", "SYK", "BSX", "DHR", "ZTS",
    "REGN", "VRTX", "BDX", "HCA", "ABT", "MCK", "CNC",
    # Consumer
    "LOW", "TGT", "TJX", "ROST", "CMG", "YUM", "MDLZ", "MO", "PM", "CL", "KMB", "EL", "GIS",
    "KHC", "HSY", "DG", "DLTR", "EBAY", "F", "GM", "MAR", "HLT", "ORLY", "AZO", "KR", "SYY",
    # Industry
    "RTX", "NOC", "GD", "MMM", "UNP", "CSX", "NSC", "FDX", "ETN", "EMR", "ITW", "PH", "WM",
    "RSG", "PCAR", "CTAS", "TDG", "CARR", "JCI", "GWW", "FAST", "DAL", "UAL", "LUV",
    # Energy and materials
    "COP", "SLB", "EOG", "PSX", "MPC", "VLO", "OXY", "KMI", "WMB", "FCX", "NEM", "APD", "SHW",
    "ECL", "DOW", "NUE", "HAL", "DVN",
    # Utilities and property
    "DUK", "SO", "D", "AEP", "EXC", "SRE", "XEL", "AMT", "PLD", "CCI", "EQIX", "SPG", "O", "PSA",
]


# Sector of every symbol the model learns from (GICS-style, kept coarse on
# purpose). Used for sector-relative features; a symbol missing here is
# treated as its own group. ETFs map to the market.
SECTOR = {}
_SECTORS = {
    "Technology": ["AAPL", "MSFT", "NVDA", "AVGO", "ORCL", "CRM", "ADBE", "AMD", "INTC", "QCOM", "CSCO", "IBM", "PLTR",
                   "ASML", "SAP", "ACN", "TXN", "AMAT", "MU", "LRCX", "ADI", "KLAC", "NOW", "INTU", "PANW", "SNPS",
                   "CDNS", "ANET", "MRVL", "FTNT", "CTSH", "HPQ", "DELL", "GLW", "APH"],
    "Communication": ["GOOGL", "META", "NFLX", "DIS", "T", "VZ", "CMCSA", "TMUS", "CHTR", "EA", "TTWO", "WBD", "OMC"],
    "Financials": ["JPM", "BAC", "WFC", "GS", "MS", "V", "MA", "AXP", "BRK-B", "BLK", "ISP.MI", "UCG.MI", "PYPL",
                   "C", "SCHW", "USB", "PNC", "TFC", "COF", "CB", "PGR", "MMC", "AON", "SPGI", "MCO", "ICE", "CME",
                   "AIG", "MET", "PRU", "BK", "AFL", "ALL", "TRV"],
    "Health": ["UNH", "JNJ", "LLY", "PFE", "MRK", "ABBV", "TMO", "NVO", "AMGN", "GILD", "BMY", "CVS", "CI", "ELV",
               "HUM", "ISRG", "MDT", "SYK", "BSX", "DHR", "ZTS", "REGN", "VRTX", "BDX", "HCA", "ABT", "MCK", "CNC"],
    "Consumer Discretionary": ["AMZN", "TSLA", "HD", "MCD", "NKE", "SBUX", "STLAM.MI", "RACE.MI", "LOW", "TJX", "ROST",
                               "CMG", "YUM", "EBAY", "F", "GM", "MAR", "HLT", "ORLY", "AZO"],
    "Consumer Staples": ["WMT", "COST", "KO", "PEP", "PG", "TGT", "MDLZ", "MO", "PM", "CL", "KMB", "EL", "GIS", "KHC",
                         "HSY", "DG", "DLTR", "KR", "SYY"],
    "Industrials": ["UBER", "CAT", "BA", "GE", "HON", "UPS", "LMT", "DE", "LDO.MI", "ADP", "RTX", "NOC", "GD", "MMM",
                    "UNP", "CSX", "NSC", "FDX", "ETN", "EMR", "ITW", "PH", "WM", "RSG", "PCAR", "CTAS", "TDG", "CARR",
                    "JCI", "GWW", "FAST", "DAL", "UAL", "LUV"],
    "Energy": ["XOM", "CVX", "ENI.MI", "COP", "SLB", "EOG", "PSX", "MPC", "VLO", "OXY", "KMI", "WMB", "HAL", "DVN"],
    "Materials": ["LIN", "FCX", "NEM", "APD", "SHW", "ECL", "DOW", "NUE"],
    "Utilities": ["NEE", "ENEL.MI", "DUK", "SO", "D", "AEP", "EXC", "SRE", "XEL"],
    "Real Estate": ["AMT", "PLD", "CCI", "EQIX", "SPG", "O", "PSA"],
    "ETF": ["SPY", "QQQ", "IWM", "GLD", "TLT", "DIA"],
}
for _sector, _symbols in _SECTORS.items():
    for _s in _symbols:
        SECTOR[_s] = _sector

# A liquid ETF that tracks each sector, used as the sector's price series.
SECTOR_ETFS = {
    "Technology": "XLK", "Communication": "VOX", "Financials": "XLF", "Health": "XLV",
    "Consumer Discretionary": "XLY", "Consumer Staples": "XLP", "Industrials": "XLI", "Energy": "XLE",
    "Materials": "XLB", "Utilities": "XLU", "Real Estate": "VNQ", "ETF": "SPY",
}
