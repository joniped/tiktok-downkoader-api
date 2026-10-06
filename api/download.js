import axios from 'axios';
import * as cheerio from 'cheerio';

// ==========================================
// FORMATTERS
// ==========================================

function formatNumber(num) {
  if (!num || isNaN(num)) return '0';
  num = parseInt(num);
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'm';
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  }
  return num.toString();
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return 'Unknown';
  const mb = bytes / (1024 * 1024);
  return mb.toFixed(2) + ' MB';
}

function parseRegion(locationCreated) {
  const regionMap = {
    US: 'United States', GB: 'United Kingdom', CA: 'Canada', AU: 'Australia',
    DE: 'Germany', FR: 'France', JP: 'Japan', KR: 'South Korea', IN: 'India',
    BR: 'Brazil', MX: 'Mexico', ID: 'Indonesia', RU: 'Russia', TR: 'Turkey',
    SA: 'Saudi Arabia', TH: 'Thailand', VN: 'Vietnam', PH: 'Philippines',
    MY: 'Malaysia', SG: 'Singapore', TW: 'Taiwan', HK: 'Hong Kong', CN: 'China',
    NG: 'Nigeria', ZA: 'South Africa', EG: 'Egypt', AE: 'UAE', PK: 'Pakistan',
    BD: 'Bangladesh', IT: 'Italy', ES: 'Spain', NL: 'Netherlands', PL: 'Poland',
  };
  return regionMap[locationCreated] || locationCreated || 'Unknown';
}

// ==========================================
// URL SANITIZATION & REDIRECT RESOLVER
// ==========================================

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
];

function cleanInputUrl(rawInput) {
  if (!rawInput) return '';

  // Extract pure URL if user pasted with title/text
  const match = rawInput.match(/https?:\/\/[^\s]+/i);
  let url = match ? match[0] : rawInput.trim();

  try {
    const parsed = new URL(url);

    // If it's a direct web link (/@user/video/12345...), strip tracking query parameters
    if (parsed.pathname.includes('/video/')) {
      return `${parsed.origin}${parsed.pathname}`;
    }

    return url;
  } catch (e) {
    if (url.includes('/video/') && url.includes('?')) {
      return url.split('?')[0];
    }
    return url;
  }
}

async function resolveRedirectUrl(shortUrl) {
  // If it already has /video/, no redirect resolution needed
  if (shortUrl.includes('/video/')) return shortUrl;

  try {
    const res = await axios.get(shortUrl, {
      headers: {
        'User-Agent': USER_AGENTS[1],
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 6000, // Short timeout to avoid Vercel limit
      maxRedirects: 5,
      validateStatus: (status) => status >= 200 && status < 400,
    });

    const finalUrl = res.request?.res?.responseUrl || res.config?.url || shortUrl;
    return cleanInputUrl(finalUrl);
  } catch (err) {
    return shortUrl;
  }
}

function extractNumericId(url) {
  const patterns = [
    /\/video\/(\d+)/,
    /\/v\/(\d+)/,
    /item_id=(\d+)/,
    /aweme_id=(\d+)/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match && match[1]) return match[1];
  }
  return null;
}

// ==========================================
// EXTRACTION STRATEGIES
// ==========================================

// Strategy 1: TikWM Gateway (Best for short links and avoiding datacenter blocks)
async function fetchFromTikWm(targetUrl) {
  try {
    const response = await axios.post(
      'https://www.tikwm.com/api/',
      new URLSearchParams({
        url: targetUrl,
        count: '12',
        cursor: '0',
        web: '1',
        hd: '1',
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'User-Agent': USER_AGENTS[0],
        },
        timeout: 7000,
      }
    );

    const result = response.data;
    if (result && result.code === 0 && result.data) {
      const item = result.data;
      const isImages = Array.isArray(item.images) && item.images.length > 0;

      const uniqueQualities = [];
      if (item.play) {
        uniqueQualities.push({
          url: item.play,
          quality: 'Normal',
          size: item.size ? formatBytes(item.size) : 'Unknown',
          sizeBytes: item.size || 0,
        });
      }
      if (item.hdplay && item.hdplay !== item.play) {
        uniqueQualities.unshift({
          url: item.hdplay,
          quality: 'HD',
          size: item.hd_size ? formatBytes(item.hd_size) : 'Unknown',
          sizeBytes: item.hd_size || 0,
        });
      }

      return {
        status: 'success',
        data: {
          type: isImages ? 'images' : 'video',
          id: item.id || '',
          desc: item.title || '',
          thumbnail: item.cover || '',
          author: {
            name: item.author?.nickname || '',
            username: item.author?.unique_id || '',
            avatar: item.author?.avatar || '',
            verified: false,
          },
          statistics: {
            likes: formatNumber(item.digg_count || 0),
            comments: formatNumber(item.comment_count || 0),
            shares: formatNumber(item.share_count || 0),
            views: formatNumber(item.play_count || 0),
            likesRaw: parseInt(item.digg_count || 0),
            commentsRaw: parseInt(item.comment_count || 0),
            sharesRaw: parseInt(item.share_count || 0),
            viewsRaw: parseInt(item.play_count || 0),
          },
          duration: item.duration || 0,
          region: parseRegion(item.region || 'Unknown'),
          createdAt: item.create_time ? new Date(item.create_time * 1000).toISOString() : new Date().toISOString(),
          video: {
            hd: item.hdplay || item.play || null,
            noWatermark: uniqueQualities,
            withWatermark: item.wmplay
              ? [
                  {
                    url: item.wmplay,
                    quality: 'Watermarked',
                    size: item.wm_size ? formatBytes(item.wm_size) : 'Unknown',
                    sizeBytes: item.wm_size || 0,
                  },
                ]
              : [],
          },
          images: isImages ? item.images.map((img) => ({ url: img, width: 1080, height: 1920 })) : [],
          music: {
            title: item.music_info?.title || 'Original Sound',
            author: item.music_info?.author || '',
            cover: item.music_info?.cover || '',
            url: item.music || item.music_info?.play || '',
            duration: item.music_info?.duration || 0,
          },
        },
      };
    }
  } catch (err) {
    console.log('TikWM fallback failed:', err.message);
  }
  return null;
}

// Strategy 2: Direct Official Aweme API (via Numeric ID)
async function fetchFromApi(numericVideoId) {
  if (!numericVideoId) return null;

  const apiEndpoints = [
    `https://api16-normal-c-useast1a.tiktokv.com/aweme/v1/feed/?aweme_id=${numericVideoId}`,
    `https://api22-normal-c-useast2a.tiktokv.com/aweme/v1/feed/?aweme_id=${numericVideoId}`,
  ];

  for (const endpoint of apiEndpoints) {
    try {
      const response = await axios.get(endpoint, {
        headers: {
          'User-Agent': USER_AGENTS[1],
          'Accept': 'application/json',
          'Referer': 'https://www.tiktok.com/',
        },
        timeout: 5000,
      });

      const list = response.data?.aweme_list;
      if (Array.isArray(list) && list.length > 0) {
        const matched = list.find((item) => String(item.aweme_id) === String(numericVideoId));
        if (matched) {
          return formatItemStruct(matched);
        }
      }
    } catch (e) {
      continue;
    }
  }
  return null;
}

// Strategy 3: Web Page Hydration Parsing
async function fetchFromWebPage(resolvedUrl) {
  if (resolvedUrl.includes('/explore') || resolvedUrl.includes('/trending')) {
    return null;
  }

  try {
    const response = await axios.get(resolvedUrl, {
      headers: {
        'User-Agent': USER_AGENTS[0],
        'Referer': 'https://www.tiktok.com/',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 5000,
    });

    const html = response.data;
    const $ = cheerio.load(html);

    const scriptContent = $('#__UNIVERSAL_DATA_FOR_REHYDRATION__').html();
    if (scriptContent) {
      const data = JSON.parse(scriptContent);
      const itemStruct = data?.['__DEFAULT_SCOPE__']?.['webapp.video-detail']?.itemInfo?.itemStruct;
      if (itemStruct) return formatItemStruct(itemStruct);
    }

    const sigiData = $('#SIGI_STATE').html();
    if (sigiData) {
      const data = JSON.parse(sigiData);
      const itemModule = data?.ItemModule;
      if (itemModule) {
        const itemKey = Object.keys(itemModule)[0];
        const itemStruct = itemModule[itemKey];
        if (itemStruct) return formatItemStruct(itemStruct);
      }
    }
  } catch (e) {}

  return null;
}

function formatItemStruct(itemStruct) {
  const isImagePost =
    (itemStruct.imagePost?.images?.length || 0) > 0 ||
    (itemStruct.image_post_info?.images?.length || 0) > 0 ||
    itemStruct.aweme_type === 150;

  const videoInfo = itemStruct.video || {};
  const authorInfo = itemStruct.author || {};
  const musicInfo = itemStruct.music || {};
  const stats = itemStruct.statistics || itemStruct.stats || {};

  const noWmQualities = [];

  if (videoInfo.play_addr?.url_list?.length > 0) {
    videoInfo.play_addr.url_list.forEach((u) => {
      if (u) {
        noWmQualities.push({
          url: u,
          quality: 'Normal',
          size: 'Unknown',
          sizeBytes: 0,
        });
      }
    });
  }

  if (Array.isArray(videoInfo.bit_rate)) {
    videoInfo.bit_rate.forEach((info) => {
      if (info.play_addr?.url_list?.[0]) {
        noWmQualities.push({
          url: info.play_addr.url_list[0],
          quality: `${info.width}x${info.height}` || 'HD',
          size: formatBytes(info.data_size || 0),
          sizeBytes: info.data_size || 0,
        });
      }
    });
  }

  const withWatermark = [];
  if (videoInfo.download_addr?.url_list?.length > 0) {
    videoInfo.download_addr.url_list.forEach((u) => {
      if (u) {
        withWatermark.push({
          url: u,
          quality: 'Watermarked',
          size: 'Unknown',
          sizeBytes: 0,
        });
      }
    });
  }

  const seenUrls = new Set();
  const dedupedNoWm = noWmQualities.filter((q) => {
    if (seenUrls.has(q.url)) return false;
    seenUrls.add(q.url);
    return true;
  });

  return {
    status: 'success',
    data: {
      type: isImagePost ? 'images' : 'video',
      id: itemStruct.aweme_id || itemStruct.id || '',
      desc: itemStruct.desc || '',
      thumbnail:
        videoInfo.cover?.url_list?.[0] ||
        videoInfo.origin_cover?.url_list?.[0] ||
        videoInfo.cover ||
        '',
      author: {
        name: authorInfo.nickname || '',
        username: authorInfo.unique_id || authorInfo.uniqueId || '',
        avatar: authorInfo.avatar_thumb?.url_list?.[0] || authorInfo.avatar_larger?.url_list?.[0] || '',
        verified: authorInfo.verification_type === 1 || authorInfo.is_verified || false,
      },
      statistics: {
        likes: formatNumber(stats.digg_count || stats.diggCount || 0),
        comments: formatNumber(stats.comment_count || stats.commentCount || 0),
        shares: formatNumber(stats.share_count || stats.shareCount || 0),
        views: formatNumber(stats.play_count || stats.playCount || 0),
        likesRaw: parseInt(stats.digg_count || stats.diggCount || 0),
        commentsRaw: parseInt(stats.comment_count || stats.commentCount || 0),
        sharesRaw: parseInt(stats.share_count || stats.shareCount || 0),
        viewsRaw: parseInt(stats.play_count || stats.playCount || 0),
      },
      duration: Math.floor((videoInfo.duration || 0) / 1000),
      region: parseRegion(itemStruct.region || 'Unknown'),
      createdAt: itemStruct.create_time
        ? new Date(itemStruct.create_time * 1000).toISOString()
        : new Date().toISOString(),
      video: {
        hd: dedupedNoWm[0]?.url || videoInfo.play_addr?.url_list?.[0] || null,
        noWatermark: dedupedNoWm,
        withWatermark: withWatermark,
      },
      images: isImagePost
        ? (itemStruct.imagePost?.images || itemStruct.image_post_info?.images || []).map((img) => ({
            url: img.url_list?.[0] || img.display_image?.url_list?.[0] || '',
            width: img.width || 1080,
            height: img.height || 1920,
          }))
        : [],
      music: {
        title: musicInfo.title || '',
        author: musicInfo.author || '',
        cover: musicInfo.cover_large?.url_list?.[0] || '',
        url: musicInfo.play_url?.url_list?.[0] || '',
        duration: Math.floor((musicInfo.duration || 0) / 1000),
      },
    },
  };
}

// ==========================================
// VERCEL SERVERLESS HANDLER
// ==========================================

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'Method not allowed' });
  }

  try {
    const rawUrl = req.method === 'POST' ? req.body?.url : req.query?.url;
    if (!rawUrl || typeof rawUrl !== 'string') {
      return res.status(400).json({ status: 'error', message: 'URL parameter is required.' });
    }

    // Step 1: Clean and sanitize URL
    const cleaned = cleanInputUrl(rawUrl);
    if (!cleaned.includes('tiktok.com') && !cleaned.includes('douyin.com')) {
      return res.status(400).json({ status: 'error', message: 'Invalid URL. Must be a TikTok link.' });
    }

    // Step 2: Resolve short links (vt.tiktok.com) to find true video link
    const resolvedUrl = await resolveRedirectUrl(cleaned);
    const numericId = extractNumericId(resolvedUrl) || extractNumericId(cleaned);

    let result = null;

    // Strategy 1: TikWM proxy
    result = await fetchFromTikWm(resolvedUrl);

    // Strategy 2: Official aweme endpoint (via ID)
    if (!result && numericId) {
      result = await fetchFromApi(numericId);
    }

    // Strategy 3: Page rehydration
    if (!result) {
      result = await fetchFromWebPage(resolvedUrl);
    }

    if (!result || result.status !== 'success') {
      return res.status(404).json({
        status: 'error',
        message: 'Could not extract video. It might be private, region-locked, or deleted.',
      });
    }

    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      message: error.message || 'Internal extraction failure.',
    });
  }
}
