let xlsxPromise = null;

function loadXlsx() {
  if (globalThis.XLSX) return Promise.resolve(globalThis.XLSX);
  if (xlsxPromise) return xlsxPromise;

  xlsxPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'xlsx.full.min.js';
    script.async = true;
    script.onload = () => globalThis.XLSX
      ? resolve(globalThis.XLSX)
      : reject(new Error('SheetJS не создал экспортный модуль.'));
    script.onerror = () => reject(new Error('Не удалось загрузить модуль XLSX.'));
    document.head.appendChild(script);
  }).catch(error => {
    xlsxPromise = null;
    throw error;
  });

  return xlsxPromise;
}

function downloadWorkbook(XLSX, { filename, sheetName, headers, rows }) {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  worksheet['!cols'] = headers.map((header, index) => ({
    wch: Math.min(80, Math.max(String(header).length + 2, ...rows.map(row => String(row[index] ?? '').length + 2)))
  }));
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  XLSX.writeFile(workbook, filename);
}

function formatValue(value) {
  return value === null || value === undefined ? '' : String(value);
}

export function buildWbRows(results) {
  return Object.entries(results || {}).map(([article, item]) => [
    article,
    formatValue(item?.wallet),
    formatValue(item?.total),
    formatValue(item?.error)
  ]);
}

export function buildCitilinkRows(results) {
  return Object.entries(results || {}).map(([article, item]) => [
    article,
    formatValue(item?.brand),
    formatValue(item?.name),
    formatValue(item?.description),
    formatValue(Array.isArray(item?.imageUrls) ? item.imageUrls.join(' | ') : ''),
    formatValue(item?.imageCount),
    formatValue(item?.status),
    formatValue(item?.error)
  ]);
}

export async function exportWbResults(results) {
  const entries = Object.entries(results || {});
  if (!entries.length) throw new Error('Нет результатов Wildberries для экспорта.');
  const XLSX = await loadXlsx();
  downloadWorkbook(XLSX, {
    filename: `wb_prices_${new Date().toISOString().slice(0, 10)}.xlsx`,
    sheetName: 'WB Prices',
    headers: ['Артикул', 'С кошельком', 'Обычная цена', 'Ошибка'],
    rows: buildWbRows(results)
  });
}

export async function exportCitilinkResults(results) {
  const entries = Object.entries(results || {});
  if (!entries.length) throw new Error('Нет результатов Citilink для экспорта.');
  const XLSX = await loadXlsx();
  downloadWorkbook(XLSX, {
    filename: `citilink_avito_${new Date().toISOString().slice(0, 10)}.xlsx`,
    sheetName: 'Citilink',
    headers: ['Артикул', 'Бренд', 'Название', 'Описание', 'Ссылки на картинки', 'Количество фото', 'Статус', 'Ошибка'],
    rows: buildCitilinkRows(results)
  });
}
