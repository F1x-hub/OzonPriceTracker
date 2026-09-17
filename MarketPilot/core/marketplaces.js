export const MARKETPLACES = Object.freeze([
  {
    id: 'ozon',
    name: 'Ozon',
    accent: '#3157C8',
    hosts: ['www.ozon.ru', 'ozon.ru', 'www.ozon.com', 'ozon.com'],
    capabilities: ['trackPrice', 'sellerReplies', 'sellerQuestions', 'richContent'],
    dashboard: {
      description: 'Мониторинг цен, отзывы и контент продавца.',
      overview: 'Мониторинг, отзывы и Rich-контент',
      defaultModule: 'tracking',
      modules: ['tracking', 'monitoring', 'reviews', 'content'],
      links: {
        products: 'https://seller.ozon.ru/app/products',
        reviews: 'https://seller.ozon.ru/app/reviews',
        questions: 'https://seller.ozon.ru/app/reviews/questions'
      }
    },
    popupActions: [
      {
        module: 'tracking',
        title: 'Мониторинг цен',
        description: 'Добавьте товар по ссылке и задайте целевую цену.',
        buttonLabel: 'Открыть мониторинг'
      }
    ],
    matches(url) {
      try {
        const parsed = new URL(url);
        return this.hosts.includes(parsed.hostname);
      } catch {
        return false;
      }
    }
  },
  {
    id: 'wildberries',
    name: 'Wildberries',
    accent: '#A50A8C',
    hosts: ['www.wildberries.ru', 'wildberries.ru'],
    capabilities: ['collectPrices'],
    dashboard: {
      description: 'Сбор цен по артикулам и экспорт результатов.',
      overview: 'Сбор цен по артикулам',
      defaultModule: 'collection',
      modules: ['collection']
    },
    collectionAction: 'fetchWbPrices',
    collectionLabel: 'цены',
    inputLabel: 'Артикулы WB',
    popupActions: [
      {
        module: 'collection',
        title: 'Сбор цен',
        description: 'Запустите сбор цен по артикулам Wildberries.',
        buttonLabel: 'Открыть сбор цен'
      }
    ],
    matches(url) {
      try {
        const parsed = new URL(url);
        return this.hosts.includes(parsed.hostname);
      } catch {
        return false;
      }
    }
  },
  {
    id: 'citilink',
    name: 'Citilink',
    accent: '#0B7A5A',
    hosts: ['www.citilink.ru', 'citilink.ru'],
    capabilities: ['collectProducts', 'exportAvito'],
    dashboard: {
      description: 'Сбор карточек, описания через AI и выгрузка.',
      overview: 'Карточки и описания для выгрузки',
      defaultModule: 'collection',
      modules: ['collection']
    },
    collectionAction: 'fetchCitilinkProducts',
    collectionLabel: 'карточки',
    inputLabel: 'Коды Citilink',
    popupActions: [
      {
        module: 'collection',
        title: 'Сбор карточек',
        description: 'Подготовьте данные товара и материалы для выгрузки.',
        buttonLabel: 'Открыть сбор карточек'
      }
    ],
    matches(url) {
      try {
        const parsed = new URL(url);
        return this.hosts.includes(parsed.hostname);
      } catch {
        return false;
      }
    }
  }
]);

export function identifyMarketplace(url) {
  return MARKETPLACES.find((marketplace) => marketplace.matches(url)) || null;
}

export function normalizeProductUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    url.search = '';
    return `${url.origin}${url.pathname}`.replace(/\/$/, '');
  } catch {
    return String(value || '').trim();
  }
}

export function isProductUrl(url, marketplaceId = 'ozon') {
  const marketplace = MARKETPLACES.find((entry) => entry.id === marketplaceId);
  if (!marketplace || !marketplace.matches(url)) return false;
  try {
    const pathname = new URL(url).pathname;
    return marketplaceId === 'ozon'
      ? pathname.startsWith('/product/')
      : marketplaceId === 'wildberries'
        ? /\/catalog\/\d+\/detail/.test(pathname)
        : pathname.includes('/product/');
  } catch {
    return false;
  }
}
