// Color Worker V18 – ανάλυση χρωμάτων εκτός κύριου νήματος
// Επιστρέφει και topColors για την πολύχρωμη στεφάνη

self.onmessage = function(e) {
  const { requestId, pixelData, width, height } = e.data;
  if (!pixelData) {
    self.postMessage({ requestId, gradient: null, mainColor: null, mainRgb: null, topColors: null });
    return;
  }

  try {
    const data = new Uint8ClampedArray(pixelData);
    const result = computePalette(data);
    self.postMessage({ requestId, ...result });
  } catch (err) {
    console.warn('[ColorWorker V18] Error:', err.message);
    self.postMessage({ requestId, gradient: null, mainColor: null, mainRgb: null, topColors: null });
  }
};

function computePalette(data) {
  const buckets = {};
  for (let i = 0; i < data.length; i += 4) {
    const r = Math.floor(data[i] / 32) * 32,
          g = Math.floor(data[i + 1] / 32) * 32,
          b = Math.floor(data[i + 2] / 32) * 32;
    const key = `${r},${g},${b}`;
    if (!buckets[key]) {
      buckets[key] = { r: data[i], g: data[i + 1], b: data[i + 2], count: 0 };
    }
    buckets[key].count++;
  }
  const sorted = Object.values(buckets).sort((a, b) => b.count - a.count);
  const main = sorted[0] ? { r: sorted[0].r, g: sorted[0].g, b: sorted[0].b } : null;
  let gradient = null;
  const colors = sorted.slice(0, 4).map(c => `rgba(${c.r},${c.g},${c.b},0.3)`);
  if (colors.length === 1) gradient = colors[0];
  else if (colors.length > 1) gradient = `linear-gradient(135deg, ${colors.join(',')})`;
  
  // V18: υπολογισμός των top colors για τη στεφάνη
  const topColors = sorted.slice(0, 4).map(c => `rgb(${c.r},${c.g},${c.b})`);
  
  return {
    gradient,
    mainColor: main ? `rgb(${main.r},${main.g},${main.b})` : null,
    mainRgb: main ? `${main.r}, ${main.g}, ${main.b}` : null,
    topColors
  };
}