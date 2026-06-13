export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { address } = req.query;
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return res.status(400).json({ error: 'Invalid address' });
  }

  const addr = address.toLowerCase();
  const KEY = process.env.BASESCAN_KEY || 'W621FSRUV27RD3WD8AIVKWZT9CZ4GWJ2SY';
  const BASE_API = 'https://api.basescan.org/api';

  // ── Known Base ecosystem contracts ──────────────────────────────────────────
  const CONTRACTS = {
    // Bridge
    BASE_BRIDGE:        '0x4200000000000000000000000000000000000010',
    // DEX
    AERODROME_ROUTER:   '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43',
    AERODROME_ROUTER2:  '0x6cb442acf35158d68425b350ec2b3b8b9f1849d2',
    UNISWAP_V3_ROUTER:  '0x2626664c2603336e57b271c5c0b26f421741e481',
    UNISWAP_UNIVERSAL:  '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad',
    // NFT / Social
    ZORA_1155:          '0x777777c338d93e2c7adf08d102d45ca7cc4ed021',
    ZORA_FACTORY:       '0x58c3ccb2dcb9384e5ab9111cd1a5dea916b0f33c',
    OPENSEA_SEAPORT:    '0x00000000000000adc04c56bf30ac9d3c0aaf14dc',
    // Basename
    BASENAME_REGISTRAR: '0x4ccb0bb02fcaba7e26cfc87876ac6e48d4b7e5d3',
    BASENAME_RESOLVER:  '0xc6d566a56a1aff6508b41f6c90ff131615583bcd',
    BASENAME_REG2:      '0x03c4738ee98ae22c9a44cf97e6c84700c89d2da1',
    // Lending
    MOONWELL:           '0xfbb21d0380bee3312b33c4353c8936a0f13ef26c',
    MOONWELL_USDC:      '0xedc817a28e8b93b03976fbd4a3ddbc9f7d176c22',
    COMPOUND_USDC:      '0xb125e6687d4313864e53df431d5425969c15eb2',
    // Other DeFi
    EXTRA_FINANCE:      '0x5d0e342ccd1ad86a16bfba26f404486940d5b595',
    MORPHO:             '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb',
  };

  async function bscan(params) {
    const qs = new URLSearchParams({ ...params, apikey: KEY }).toString();
    const r = await fetch(`${BASE_API}?${qs}`);
    const j = await r.json();
    return j;
  }

  try {
    const [txRes, balRes, erc20Res, internalRes, nftRes] = await Promise.all([
      bscan({ module: 'account', action: 'txlist',         address: addr, startblock: 0, endblock: 99999999, sort: 'asc' }),
      bscan({ module: 'account', action: 'balance',        address: addr, tag: 'latest' }),
      bscan({ module: 'account', action: 'tokentx',        address: addr, startblock: 0, endblock: 99999999, sort: 'asc' }),
      bscan({ module: 'account', action: 'txlistinternal', address: addr, startblock: 0, endblock: 99999999, sort: 'asc' }),
      bscan({ module: 'account', action: 'tokennfttx',     address: addr, startblock: 0, endblock: 99999999, sort: 'asc' }),
    ]);

    const txns    = txRes.status    === '1' ? txRes.result    : [];
    const balWei  = balRes.status   === '1' ? balRes.result   : '0';
    const erc20   = erc20Res.status === '1' ? erc20Res.result : [];
    const internal= internalRes.status==='1'? internalRes.result : [];
    const nfts    = nftRes.status   === '1' ? nftRes.result   : [];

    const ethBal = Number(balWei) / 1e18;

    // ── Basic metrics ─────────────────────────────────────────────────────────
    let walletAgeDays = 0, firstTxTimestamp = null;
    if (txns.length > 0) {
      firstTxTimestamp = Number(txns[0].timeStamp);
      walletAgeDays = Math.floor((Date.now() / 1000 - firstTxTimestamp) / 86400);
    }

    const activeDaysSet = new Set(txns.map(t => {
      const d = new Date(Number(t.timeStamp) * 1000);
      return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    }));
    const activeDays = activeDaysSet.size;

    const activeMonthsSet = new Set(txns.map(t => {
      const d = new Date(Number(t.timeStamp) * 1000);
      return `${d.getFullYear()}-${d.getMonth()}`;
    }));
    const activeMonths = activeMonthsSet.size;

    const allToAddrs = new Set(txns.map(t => t.to?.toLowerCase()).filter(Boolean));

    const contractsOut = new Set(
      txns.filter(t => t.to && t.to.toLowerCase() !== addr && t.input && t.input !== '0x')
          .map(t => t.to.toLowerCase())
    );
    const uniqueContracts = contractsOut.size;

    const tokenContracts = new Set(erc20.map(t => t.contractAddress?.toLowerCase()).filter(Boolean));
    const tokenDiversity = tokenContracts.size;

    const outgoingTxns = txns.filter(t => t.from?.toLowerCase() === addr);

    // inbound ETH — first funder
    let fundedBy = null;
    const inboundEth = [...txns, ...internal]
      .filter(t => t.to?.toLowerCase() === addr && Number(t.value) > 0)
      .sort((a, b) => Number(a.timeStamp) - Number(b.timeStamp));
    if (inboundEth.length > 0) fundedBy = inboundEth[0].from?.toLowerCase();

    const selfTransfers = txns.filter(t =>
      t.to?.toLowerCase() === addr && t.from?.toLowerCase() === addr).length;
    const failedTxns = txns.filter(t => t.isError === '1').length;

    // ── Bot patterns ──────────────────────────────────────────────────────────
    let burstActivity = false;
    if (txns.length >= 5) {
      const hb = {};
      txns.forEach(t => { const h = Math.floor(Number(t.timeStamp) / 3600); hb[h] = (hb[h]||0)+1; });
      burstActivity = Math.max(...Object.values(hb)) > Math.max(5, txns.length * 0.6);
    }
    let uniformGas = false;
    if (outgoingTxns.length >= 5) {
      uniformGas = new Set(outgoingTxns.map(t => t.gasPrice)).size === 1;
    }

    // ── Checklist detection ───────────────────────────────────────────────────
    const cv = Object.values(CONTRACTS);

    // Bridge: interacted with Base bridge, OR has inbound internal tx from bridge
    const hasBridge = allToAddrs.has(CONTRACTS.BASE_BRIDGE)
      || internal.some(t => t.from?.toLowerCase() === CONTRACTS.BASE_BRIDGE && t.to?.toLowerCase() === addr);

    // Basename: interacted with any basename registrar/resolver
    const hasBasename = [CONTRACTS.BASENAME_REGISTRAR, CONTRACTS.BASENAME_RESOLVER, CONTRACTS.BASENAME_REG2]
      .some(c => allToAddrs.has(c));

    // Aerodrome
    const hasAerodrome = [CONTRACTS.AERODROME_ROUTER, CONTRACTS.AERODROME_ROUTER2]
      .some(c => allToAddrs.has(c));

    // Uniswap on Base
    const hasUniswap = [CONTRACTS.UNISWAP_V3_ROUTER, CONTRACTS.UNISWAP_UNIVERSAL]
      .some(c => allToAddrs.has(c));

    // NFT mint: interacted with Zora or OpenSea, OR has NFT receive tx
    const hasNFT = [CONTRACTS.ZORA_1155, CONTRACTS.ZORA_FACTORY, CONTRACTS.OPENSEA_SEAPORT]
      .some(c => allToAddrs.has(c)) || nfts.length > 0;

    // Zora specifically
    const hasZora = [CONTRACTS.ZORA_1155, CONTRACTS.ZORA_FACTORY].some(c => allToAddrs.has(c));

    // Lending: Moonwell or Compound
    const hasLending = [CONTRACTS.MOONWELL, CONTRACTS.MOONWELL_USDC, CONTRACTS.COMPOUND_USDC]
      .some(c => allToAddrs.has(c));

    // Morpho
    const hasMorpho = allToAddrs.has(CONTRACTS.MORPHO);

    // Any DEX usage
    const hasDEX = hasAerodrome || hasUniswap;

    // NFT count
    const nftCount = new Set(nfts.map(t => t.contractAddress?.toLowerCase())).size;

    // ── Checklist object ──────────────────────────────────────────────────────
    const checklist = [
      { id: 'bridge',    label: 'Bridge ke Base',          done: hasBridge,   points: 15, tip: 'Gunakan official Base Bridge dari Ethereum' },
      { id: 'basename',  label: 'Punya Basename (.base)',   done: hasBasename, points: 20, tip: 'Register di base.org — sinyal kuat Coinbase user' },
      { id: 'dex',       label: 'Swap di DEX',             done: hasDEX,      points: 15, tip: 'Aerodrome atau Uniswap V3 di Base' },
      { id: 'aerodrome', label: 'Pakai Aerodrome',         done: hasAerodrome,points: 10, tip: 'DEX native Base — LP atau swap' },
      { id: 'nft',       label: 'Mint/Hold NFT di Base',   done: hasNFT,      points: 10, tip: 'Zora, OpenSea, atau protocol NFT lain' },
      { id: 'zora',      label: 'Mint di Zora',            done: hasZora,     points: 10, tip: 'Zora adalah protokol NFT favorit ekosistem Base' },
      { id: 'lending',   label: 'Pakai Lending (Moonwell)', done: hasLending, points: 15, tip: 'Deposit/borrow di Moonwell atau Compound Base' },
      { id: 'morpho',    label: 'Pakai Morpho',            done: hasMorpho,   points: 10, tip: 'Morpho Blue — lending terbaru di Base' },
      { id: 'age_90',    label: 'Wallet >90 hari',         done: walletAgeDays >= 90,  points: 10, tip: 'Wallet lama = lebih dipercaya' },
      { id: 'age_365',   label: 'Wallet >365 hari',        done: walletAgeDays >= 365, points: 10, tip: 'OG Base user sejak awal' },
      { id: 'txn_50',    label: '50+ transaksi',           done: txns.length >= 50,    points: 10, tip: 'Aktivitas sustained' },
      { id: 'months_3',  label: 'Aktif 3+ bulan',          done: activeMonths >= 3,    points: 10, tip: 'Konsisten selama beberapa bulan' },
      { id: 'months_6',  label: 'Aktif 6+ bulan',          done: activeMonths >= 6,    points: 15, tip: 'Power user Base' },
      { id: 'tokens_5',  label: '5+ jenis token berbeda',  done: tokenDiversity >= 5,  points: 5,  tip: 'Diversifikasi interaksi DeFi' },
    ];

    const checklistDone  = checklist.filter(c => c.done).length;
    const checklistTotal = checklist.length;
    const checklistPoints = checklist.filter(c => c.done).reduce((s, c) => s + c.points, 0);
    const checklistMaxPoints = checklist.reduce((s, c) => s + c.points, 0);

    // ── Airdrop tier ──────────────────────────────────────────────────────────
    // Based on L2 precedent (OP/ARB style) + checklist points
    let tier, tierLabel, estMin, estMax, tierColor;

    if (walletAgeDays >= 365 && txns.length >= 100 && activeMonths >= 6 && uniqueContracts >= 20) {
      tier = 4; tierLabel = '🥇 OG'; estMin = 2000; estMax = 5000; tierColor = 'gold';
    } else if (walletAgeDays >= 180 && txns.length >= 50 && activeMonths >= 3 && uniqueContracts >= 10) {
      tier = 3; tierLabel = '🥈 Power User'; estMin = 500; estMax = 2000; tierColor = 'silver';
    } else if (walletAgeDays >= 90 && txns.length >= 20 && uniqueContracts >= 5) {
      tier = 2; tierLabel = '🥉 Active User'; estMin = 100; estMax = 500; tierColor = 'bronze';
    } else if (txns.length >= 5 && walletAgeDays >= 14) {
      tier = 1; tierLabel = '📋 Minimal'; estMin = 0; estMax = 100; tierColor = 'dim';
    } else {
      tier = 0; tierLabel = '❌ Not Eligible'; estMin = 0; estMax = 0; tierColor = 'red';
    }

    // ── Sybil scoring ─────────────────────────────────────────────────────────
    const flags = [];
    let score = 0;

    if (txns.length === 0) {
      flags.push('no_transactions'); score += 40;
    } else {
      if (walletAgeDays < 30)   { flags.push('fresh_wallet');        score += 25; }
      else if (walletAgeDays < 90) {                                  score +=  8; }
      if (outgoingTxns.length < 10) { flags.push('low_tx_count');    score += 15; }
      if (activeDays < 5)        { flags.push('low_active_days');     score += 15; }
      if (activeMonths < 2)      { flags.push('low_active_months');   score += 10; }
      if (uniqueContracts < 3)   { flags.push('few_contracts');       score += 15; }
      if (tokenDiversity < 2)    { flags.push('low_token_diversity'); score += 10; }
      if (ethBal < 0.001)        { flags.push('dust_balance');        score += 10; }
      if (burstActivity)         { flags.push('burst_activity');      score += 20; }
      if (uniformGas)            { flags.push('uniform_gas_price');   score += 15; }
      if (selfTransfers > 0)     { flags.push('self_transfer');       score += 10; }
      if (failedTxns > txns.length * 0.3 && failedTxns > 3) {
        flags.push('high_fail_rate'); score += 10;
      }
    }
    score = Math.min(100, score);
    const risk = score >= 65 ? 'high' : score >= 35 ? 'medium' : 'low';

    // If sybil = downgrade tier
    if (risk === 'high' && tier > 0) { tier = 0; tierLabel = '🚫 Sybil Filtered'; estMin = 0; estMax = 0; }

    return res.status(200).json({
      address: addr,
      score,
      risk,
      flags,
      tier: { level: tier, label: tierLabel, estMin, estMax, color: tierColor },
      checklist: { items: checklist, done: checklistDone, total: checklistTotal, points: checklistPoints, maxPoints: checklistMaxPoints },
      data: {
        walletAgeDays, firstTxTimestamp,
        txCount: txns.length, outgoingTxCount: outgoingTxns.length,
        activeDays, activeMonths, uniqueContracts, tokenDiversity,
        ethBalance: ethBal, fundedBy, selfTransfers, failedTxns,
        burstActivity, uniformGas, nftCount,
      }
    });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Internal server error' });
  }
}
