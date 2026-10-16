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
