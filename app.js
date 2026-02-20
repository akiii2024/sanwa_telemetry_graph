const { useCallback, useEffect, useMemo, useRef, useState } = React;

const TIME_KEYS = ["TOTAL LAP", "BEST LAP", "AVERAGE LAP"];

function splitCsvLine(line) {
  return line.split(",").map((value) => value.trim());
}

function cleanValue(value) {
  return value.replace(/^'+|'+$/g, "").trim();
}

function timeToMs(value) {
  const cleaned = cleanValue(value);
  if (!cleaned) return 0;
  const parts = cleaned.split(":");
  if (parts.length !== 3) return 0;
  const [hh, mm, rest] = parts;
  const [ss, frac = "0"] = rest.split(".");
  const seconds = Number(hh) * 3600 + Number(mm) * 60 + Number(ss);
  const fracMs = Math.round(Number(`0.${frac}`) * 1000);
  return seconds * 1000 + fracMs;
}

function formatMs(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(totalSeconds / 3600);
  const mm = Math.floor((totalSeconds % 3600) / 60);
  const ss = totalSeconds % 60;
  const frac = Math.floor((ms % 1000) / 10);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(frac).padStart(2, "0")}`;
}

function parseCsv(text) {
  const lines = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((line) => line.trim() !== "");

  const summary = {};
  let headerIndex = lines.findIndex((line) => line.startsWith("LAP,"));
  if (headerIndex === -1) {
    headerIndex = lines.findIndex((line) => line.startsWith("LAP "));
  }

  lines.slice(0, headerIndex).forEach((line) => {
    const parts = splitCsvLine(line);
    if (parts.length >= 2) {
      const key = cleanValue(parts[0]);
      if (TIME_KEYS.includes(key)) {
        summary[key] = cleanValue(parts[1]);
      }
    }
  });

  if (headerIndex === -1) {
    return { summary, columns: [], rows: [] };
  }

  const columns = splitCsvLine(lines[headerIndex]).map(cleanValue).filter(Boolean);
  const rows = lines
    .slice(headerIndex + 1)
    .map((line) => splitCsvLine(line))
    .filter((parts) => {
      const recTime = cleanValue(parts[2] || "");
      return recTime.includes(":");
    });

  const data = rows.map((parts) => {
    const row = {};
    columns.forEach((col, index) => {
      row[col] = cleanValue(parts[index] || "");
    });
    row.__recMs = timeToMs(row["REC TIME"] || row["REC TIME "] || "");
    row.__lapMs = timeToMs(row["LAP TIME"] || "");
    return row;
  });

  return { summary, columns, rows: data };
}

function getNumericValue(value) {
  if (value === undefined || value === null) return 0;
  const cleaned = String(value).replace(/[^0-9.-]/g, "");
  const parsed = Number(cleaned);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function getPercentile(values, percentile) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * percentile)));
  return sorted[index];
}

function smoothSeries(values, windowSize) {
  if (!values.length) return [];
  const radius = Math.max(0, Math.floor(windowSize / 2));
  return values.map((_, index) => {
    let sum = 0;
    let count = 0;
    const start = Math.max(0, index - radius);
    const end = Math.min(values.length - 1, index + radius);
    for (let i = start; i <= end; i++) {
      sum += values[i];
      count += 1;
    }
    return count ? sum / count : values[index];
  });
}

function applySteerCurve(value, maxValue, gamma) {
  if (!maxValue) return 0;
  const normalized = Math.max(-1, Math.min(1, value / maxValue));
  const sign = Math.sign(normalized);
  return sign * Math.pow(Math.abs(normalized), gamma);
}

function buildLinePath(data, metric, width, height, padding) {
  if (!data.length) return "";
  const times = data.map((row) => row.__recMs);
  const values = data.map((row) => getNumericValue(row[metric]));
  const minX = Math.min(...times);
  const maxX = Math.max(...times);
  const minY = Math.min(...values);
  const maxY = Math.max(...values);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;

  const toX = (t) => padding + ((t - minX) / spanX) * (width - padding * 2);
  const toY = (v) => height - padding - ((v - minY) / spanY) * (height - padding * 2);

  return data
    .map((row, index) => {
      const x = toX(row.__recMs);
      const y = toY(getNumericValue(row[metric]));
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

function valueAtTime(data, metric, timeMs) {
  if (!data.length) return 0;
  let low = 0;
  let high = data.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const rec = data[mid].__recMs;
    if (rec === timeMs) return getNumericValue(data[mid][metric]);
    if (rec < timeMs) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  const index = Math.max(0, Math.min(data.length - 1, low));
  return getNumericValue(data[index][metric]);
}

function buildLapPoints(rows, stMetric, thMetric, stMax, thMax, options) {
  const hasTh = rows.some((row) => row[thMetric] !== undefined);
  if (!rows.length) return [];
  const directionFactor = options.direction === "cw" ? -1 : 1;
  const steerSpeedLoss = Math.max(0, Math.min(1, options.steerSpeedLoss ?? 0));
  const brakeSpeedLoss = Math.max(0, Math.min(1, options.brakeSpeedLoss ?? 0));
  const gamma = Math.max(0.4, Math.min(2.5, options.steerGamma ?? 1.2));

  const stSeries = rows.map((row) => getNumericValue(row[stMetric]));
  const thSeries = rows.map((row) => getNumericValue(row[thMetric]));
  const smoothWindow = Math.max(1, Math.floor(options.smoothWindow ?? 5));
  const stSmoothed = smoothSeries(stSeries, smoothWindow);
  const thSmoothed = smoothSeries(thSeries, smoothWindow);

  const points = [];
  let x = 0;
  let y = 0;
  let angle = -Math.PI / 2;
  let lastTime = rows[0]?.__recMs ?? 0;
  const baseDt = options.baseDt ?? 50;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const stValue = stSmoothed[i] ?? getNumericValue(row[stMetric]);
    const thValue = hasTh ? (thSmoothed[i] ?? getNumericValue(row[thMetric])) : 50;
    const dtMs = Math.max(1, row.__recMs - lastTime || baseDt);
    lastTime = row.__recMs;
    const accelRatio = Math.max(0, thValue / thMax);
    const brakeRatio = Math.max(0, -thValue / thMax);
    const brakeFactor = 1 - brakeRatio * brakeSpeedLoss;
    const speedRatio = Math.max(0, accelRatio * brakeFactor);
    const steerCurve = applySteerCurve(stValue, stMax, gamma);
    const curvature =
      steerCurve *
      options.steerGain *
      directionFactor *
      (1 - steerSpeedLoss * speedRatio);
    const speed = 0.3 + 0.7 * speedRatio;
    const dtScale = dtMs / baseDt;
    const segmentLength = speed * options.baseSpeed * dtScale;

    angle += curvature * 0.15 * dtScale;
    x += Math.cos(angle) * segmentLength;
    y += Math.sin(angle) * segmentLength;

    points.push({
      x,
      y,
      time: row.__recMs,
    });
  }

  return points;
}

function interpolatePoint(points, timeMs) {
  if (!points.length) return null;
  if (timeMs <= points[0].time) return points[0];
  if (timeMs >= points[points.length - 1].time)
    return points[points.length - 1];

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (a.time <= timeMs && b.time >= timeMs) {
      const t = (timeMs - a.time) / (b.time - a.time || 1);
      return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        time: timeMs,
      };
    }
  }
  return points[points.length - 1];
}

function closeLoop(points) {
  if (points.length < 2) return points;
  const start = points[0];
  const end = points[points.length - 1];
  const driftX = end.x - start.x;
  const driftY = end.y - start.y;
  const lastIndex = points.length - 1;
  return points.map((point, index) => {
    const t = index / lastIndex;
    return {
      ...point,
      x: point.x - driftX * t,
      y: point.y - driftY * t,
    };
  });
}

// ストレート区間（ST%が0付近で安定している区間）を検出する関数
function detectStraightSections(rows, stMetric, minDurationMs = 500) {
  const straights = [];
  const threshold = 5; // ST%がこの値以内なら「ほぼ直進」とみなす
  let straightStart = null;

  for (let i = 0; i < rows.length; i++) {
    const stValue = Math.abs(getNumericValue(rows[i][stMetric]));
    const isStraight = stValue <= threshold;

    if (isStraight && straightStart === null) {
      straightStart = i;
    } else if (!isStraight && straightStart !== null) {
      const durationMs = rows[i].__recMs - rows[straightStart].__recMs;
      if (durationMs >= minDurationMs) {
        straights.push({
          startIndex: straightStart,
          endIndex: i - 1,
          startMs: rows[straightStart].__recMs,
          endMs: rows[i - 1].__recMs,
          durationMs: durationMs,
          // ストレートの中心時刻
          centerMs: (rows[straightStart].__recMs + rows[i - 1].__recMs) / 2,
        });
      }
      straightStart = null;
    }
  }

  // 最後まで直進が続いていた場合
  if (straightStart !== null) {
    const durationMs = rows[rows.length - 1].__recMs - rows[straightStart].__recMs;
    if (durationMs >= minDurationMs) {
      straights.push({
        startIndex: straightStart,
        endIndex: rows.length - 1,
        startMs: rows[straightStart].__recMs,
        endMs: rows[rows.length - 1].__recMs,
        durationMs: durationMs,
        centerMs: (rows[straightStart].__recMs + rows[rows.length - 1].__recMs) / 2,
      });
    }
  }

  return straights;
}

// 操作の周期性からラップを予測する関数
function predictLapsFromPeriodicity(rows) {
  const emptyResult = {
    predictedLapCount: 0,
    predictedBestLap: null,
    predictedAverageLap: null,
    detectedPeriodMs: 0,
    lapTimes: [],
  };

  if (rows.length < 100) return emptyResult;

  const stMetric = "ST(%)";
  const hasSt = rows.some((row) => row[stMetric] !== undefined);
  if (!hasSt) return emptyResult;

  // サンプリングレートを推定
  const sampleIntervalMs = rows.length > 1 ? (rows[rows.length - 1].__recMs - rows[0].__recMs) / (rows.length - 1) : 100;

  // ステアリングデータを正規化
  const stValues = rows.map((row) => getNumericValue(row[stMetric]));
  const mean = stValues.reduce((a, b) => a + b, 0) / stValues.length;
  const normalized = stValues.map((v) => v - mean);

  // 自己相関を計算して大まかな周期を検出（検索範囲: 5秒～120秒）
  const minLagMs = 5000;
  const maxLagMs = Math.min(120000, rows[rows.length - 1].__recMs / 2);
  const minLag = Math.floor(minLagMs / sampleIntervalMs);
  const maxLag = Math.min(Math.floor(maxLagMs / sampleIntervalMs), Math.floor(normalized.length / 2));

  let bestLag = 0;
  let bestCorr = -Infinity;

  const step = Math.max(1, Math.floor((maxLag - minLag) / 500));
  for (let lag = minLag; lag < maxLag; lag += step) {
    let sum = 0;
    let count = 0;
    for (let i = 0; i < normalized.length - lag; i++) {
      sum += normalized[i] * normalized[i + lag];
      count++;
    }
    const corr = count > 0 ? sum / count : 0;
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }

  // ピーク周辺を詳細に調べる
  const refinedMinLag = Math.max(minLag, bestLag - step * 2);
  const refinedMaxLag = Math.min(maxLag, bestLag + step * 2);
  for (let lag = refinedMinLag; lag < refinedMaxLag; lag++) {
    let sum = 0;
    let count = 0;
    for (let i = 0; i < normalized.length - lag; i++) {
      sum += normalized[i] * normalized[i + lag];
      count++;
    }
    const corr = count > 0 ? sum / count : 0;
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }

  const detectedPeriodMs = bestLag * sampleIntervalMs;

  // 周期の信頼性チェック
  const variance = normalized.reduce((sum, v) => sum + v * v, 0) / normalized.length;
  const corrRatio = variance > 0 ? bestCorr / variance : 0;

  // 信頼性が低い場合でも、検出周期からの推定値は返す
  if (corrRatio < 0.2 || detectedPeriodMs < 5000) {
    // 最低限の推定（信頼性低）
    const totalDurationMs = rows[rows.length - 1].__recMs - rows[0].__recMs;
    const estimatedLapCount = detectedPeriodMs > 0 ? Math.floor(totalDurationMs / detectedPeriodMs) : 0;
    return {
      predictedLapCount: estimatedLapCount,
      predictedBestLap: detectedPeriodMs > 0 ? detectedPeriodMs : null,
      predictedAverageLap: detectedPeriodMs > 0 ? detectedPeriodMs : null,
      detectedPeriodMs,
      lapTimes: [],
      lowConfidence: true, // 信頼性が低いことを示すフラグ
    };
  }

  // ストレート区間を検出（最低500ms以上の直進区間）
  const straights = detectStraightSections(rows, stMetric, 500);

  if (straights.length < 2) {
    // ストレートが少なすぎる場合は従来の周期ベース推定にフォールバック
    const totalDurationMs = rows[rows.length - 1].__recMs - rows[0].__recMs;
    const predictedLapCount = Math.floor(totalDurationMs / detectedPeriodMs);
    return {
      predictedLapCount,
      predictedBestLap: detectedPeriodMs,
      predictedAverageLap: detectedPeriodMs,
      detectedPeriodMs,
      lapTimes: [],
    };
  }

  // 最も長いストレートを「メインストレート」として特定
  const sortedByDuration = [...straights].sort((a, b) => b.durationMs - a.durationMs);
  const mainStraightDuration = sortedByDuration[0].durationMs;
  // メインストレートの80%以上の長さを持つストレートを候補とする
  const mainStraightThreshold = mainStraightDuration * 0.6;
  const mainStraights = straights.filter(s => s.durationMs >= mainStraightThreshold);

  if (mainStraights.length < 2) {
    // メインストレートが1つしかない
    const totalDurationMs = rows[rows.length - 1].__recMs - rows[0].__recMs;
    const predictedLapCount = Math.floor(totalDurationMs / detectedPeriodMs);
    return {
      predictedLapCount,
      predictedBestLap: detectedPeriodMs,
      predictedAverageLap: detectedPeriodMs,
      detectedPeriodMs,
      lapTimes: [],
    };
  }

  // メインストレートの間隔が周期に近いものだけを抽出（誤検出を防ぐ）
  const validMainStraights = [mainStraights[0]];
  for (let i = 1; i < mainStraights.length; i++) {
    const interval = mainStraights[i].centerMs - validMainStraights[validMainStraights.length - 1].centerMs;
    // 周期の50%〜150%の範囲内であれば有効
    if (interval >= detectedPeriodMs * 0.5 && interval <= detectedPeriodMs * 1.5) {
      validMainStraights.push(mainStraights[i]);
    }
  }

  if (validMainStraights.length < 2) {
    const totalDurationMs = rows[rows.length - 1].__recMs - rows[0].__recMs;
    const predictedLapCount = Math.floor(totalDurationMs / detectedPeriodMs);
    return {
      predictedLapCount,
      predictedBestLap: detectedPeriodMs,
      predictedAverageLap: detectedPeriodMs,
      detectedPeriodMs,
      lapTimes: [],
    };
  }

  // 各ラップタイムを計算（ストレート終了地点をラップの区切りとする）
  const lapTimes = [];
  for (let i = 0; i < validMainStraights.length - 1; i++) {
    const lapStartMs = validMainStraights[i].endMs;
    const lapEndMs = validMainStraights[i + 1].endMs;
    const durationMs = lapEndMs - lapStartMs;
    lapTimes.push({
      lap: i + 1,
      startMs: lapStartMs,
      endMs: lapEndMs,
      durationMs: durationMs,
    });
  }

  if (lapTimes.length === 0) {
    return emptyResult;
  }

  // ベストラップとアベレージラップを計算
  const bestLapTime = Math.min(...lapTimes.map(l => l.durationMs));
  const averageLapTime = lapTimes.reduce((sum, l) => sum + l.durationMs, 0) / lapTimes.length;

  return {
    predictedLapCount: lapTimes.length,
    predictedBestLap: bestLapTime,
    predictedAverageLap: averageLapTime,
    detectedPeriodMs,
    lapTimes,
  };
}

// 全区間の操作を使って周回コースを推定
function calculateCourseShape(rows, lapTimeMs, lapData, options) {
  if (!rows.length) return { points: [], lapDuration: 0 };

  const stMetric = "ST(%)";
  const thMetric = "TH(%)";
  const hasSt = rows.some((row) => row[stMetric] !== undefined);
  if (!hasSt) return { points: [], lapDuration: 0 };

  const stMax = Math.max(
    getPercentile(rows.map((row) => Math.abs(getNumericValue(row[stMetric]))), 0.95),
    1
  );
  const thMax = Math.max(
    getPercentile(rows.map((row) => Math.abs(getNumericValue(row[thMetric]))), 0.95),
    1
  );

  const avgLapTimeMs = lapData.length
    ? lapData.reduce((acc, lap) => {
      const startTime = rows[lap.start]?.__recMs ?? 0;
      const endTime = rows[lap.end]?.__recMs ?? startTime;
      return acc + Math.max(0, endTime - startTime);
    }, 0) / lapData.length
    : 0;
  const resolvedLapTimeMs = lapData.length ? avgLapTimeMs || lapTimeMs : lapTimeMs;

  if (!resolvedLapTimeMs) return { points: [], lapDuration: 0 };

  const laps = [];

  if (options.lapSource === "lap" && lapData.length) {
    lapData.forEach((lap) => {
      const lapRows = rows.slice(lap.start, lap.end + 1);
      if (lapRows.length < 2) return;
      const lapStartTime = lapRows[0].__recMs;
      const normalizedRows = lapRows.map((row) => ({
        ...row,
        __recMs: row.__recMs - lapStartTime,
      }));
      laps.push(buildLapPoints(normalizedRows, stMetric, thMetric, stMax, thMax, options));
    });
  } else {
    const lapCount = Math.max(
      1,
      Math.floor(rows[rows.length - 1].__recMs / resolvedLapTimeMs)
    );
    for (let lapIndex = 0; lapIndex < lapCount; lapIndex++) {
      const lapStart = lapIndex * resolvedLapTimeMs;
      const lapEnd = lapStart + resolvedLapTimeMs;
      const lapRows = rows
        .filter((row) => row.__recMs >= lapStart && row.__recMs <= lapEnd)
        .map((row) => ({ ...row, __recMs: row.__recMs - lapStart }));
      if (lapRows.length < 2) continue;
      laps.push(buildLapPoints(lapRows, stMetric, thMetric, stMax, thMax, options));
    }
  }

  if (!laps.length) return { points: [], lapDuration: resolvedLapTimeMs };

  const sampleCount = 240;
  const averaged = [];

  for (let i = 0; i < sampleCount; i++) {
    const t = (resolvedLapTimeMs * i) / (sampleCount - 1);
    const samples = laps
      .map((lap) => interpolatePoint(lap, t))
      .filter(Boolean);
    if (!samples.length) continue;
    const sum = samples.reduce(
      (acc, point) => {
        acc.x += point.x;
        acc.y += point.y;
        return acc;
      },
      { x: 0, y: 0 }
    );
    averaged.push({
      x: sum.x / samples.length,
      y: sum.y / samples.length,
      time: t,
    });
  }

  const closed = closeLoop(averaged);
  const straightIndex = findStraightStartIndex(closed);
  return {
    points: rotatePoints(closed, straightIndex, resolvedLapTimeMs),
    lapDuration: resolvedLapTimeMs,
  };
}

function rotatePoints(points, startIndex, durationMs) {
  if (!points.length) return points;
  const rotated = points.slice(startIndex).concat(points.slice(0, startIndex));
  if (!rotated.length) return rotated;
  const span = Math.max(1, rotated.length - 1);
  return rotated.map((point, index) => ({
    ...point,
    time: (durationMs * index) / span,
  }));
}

function findStraightStartIndex(points) {
  const count = points.length;
  if (count < 3) return 0;
  const curvatures = points.map((point, index) => {
    const prev = points[(index - 1 + count) % count];
    const next = points[(index + 1) % count];
    const v1x = point.x - prev.x;
    const v1y = point.y - prev.y;
    const v2x = next.x - point.x;
    const v2y = next.y - point.y;
    const len1 = Math.hypot(v1x, v1y);
    const len2 = Math.hypot(v2x, v2y);
    if (!len1 || !len2) return Math.PI;
    const dot = v1x * v2x + v1y * v2y;
    const cos = Math.max(-1, Math.min(1, dot / (len1 * len2)));
    return Math.acos(cos);
  });

  const threshold = 0.08;
  let bestStart = 0;
  let bestLength = 0;
  let currentStart = 0;
  let currentLength = 0;

  for (let i = 0; i < count * 2; i++) {
    const index = i % count;
    if (curvatures[index] < threshold) {
      if (currentLength === 0) currentStart = i;
      currentLength += 1;
      if (currentLength > bestLength) {
        bestLength = currentLength;
        bestStart = currentStart;
      }
    } else {
      currentLength = 0;
    }
  }

  if (!bestLength || bestLength >= count) return 0;
  return (bestStart + Math.floor(bestLength / 2)) % count;
}

function detectCourseDirection(rows) {
  const stMetric = "ST(%)";
  if (!rows.length || !rows.some((row) => row[stMetric] !== undefined)) {
    return "ccw";
  }
  const threshold = 5;
  let sum = 0;
  let count = 0;
  rows.forEach((row) => {
    const value = getNumericValue(row[stMetric]);
    if (Math.abs(value) < threshold) return;
    sum += value;
    count += 1;
  });
  if (!count) return "ccw";
  return sum >= 0 ? "cw" : "ccw";
}

function getCourseTransform(points, mapWidth, mapHeight, padding) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;
  const scale = Math.min(
    (mapWidth - padding * 2) / rangeX,
    (mapHeight - padding * 2) / rangeY
  );
  const offsetX = (mapWidth - rangeX * scale) / 2;
  const offsetY = (mapHeight - rangeY * scale) / 2;

  return {
    minX,
    minY,
    maxX,
    maxY,
    scale,
    offsetX,
    offsetY,
    toX: (px) => offsetX + (px - minX) * scale,
    toY: (py) => offsetY + (py - minY) * scale,
    fromX: (sx) => minX + (sx - offsetX) / scale,
    fromY: (sy) => minY + (sy - offsetY) / scale,
  };
}



function smoothClosedPoints(points, windowSize) {
  if (!points.length) return points;
  const radius = Math.max(0, Math.floor(windowSize / 2));
  if (!radius) return points;
  const count = points.length;
  return points.map((_, index) => {
    let sumX = 0;
    let sumY = 0;
    let sumCount = 0;
    for (let offset = -radius; offset <= radius; offset += 1) {
      const i = (index + offset + count) % count;
      sumX += points[i].x;
      sumY += points[i].y;
      sumCount += 1;
    }
    return {
      ...points[index],
      x: sumX / sumCount,
      y: sumY / sumCount,
    };
  });
}


// コースマップコンポーネント（編集可能）
function CourseMap({
  rows,
  lapTimeMs,
  currentTime,
  options,
  editedPoints,
  onPointsChange,
}) {
  // 自動生成されたポイント
  const { points: generatedPoints, lapDuration } = useMemo(
    () => calculateCourseShape(rows, lapTimeMs, [], options),
    [rows, lapTimeMs, options]
  );

  // 編集中のポイント（外部管理または自動生成）
  const points = editedPoints && editedPoints.length ? editedPoints : generatedPoints;
  const isEdited = editedPoints && editedPoints.length > 0;

  // 編集モードの状態
  const [isEditing, setIsEditing] = useState(false);
  const [draggingIndex, setDraggingIndex] = useState(null);
  const svgRef = useRef(null);

  // マップのサイズと余白
  const mapWidth = 400;
  const mapHeight = 300;
  const padding = 30;
  const activeLapDuration = lapDuration || lapTimeMs || 1000;

  const transform = useMemo(() => {
    if (!points.length) return null;
    return getCourseTransform(points, mapWidth, mapHeight, padding);
  }, [points, mapWidth, mapHeight, padding]);

  // SVG座標からポイント座標に変換
  const svgToPoint = useCallback((clientX, clientY) => {
    if (!svgRef.current || !transform) return null;
    const svg = svgRef.current;
    const rect = svg.getBoundingClientRect();
    const svgX = ((clientX - rect.left) / rect.width) * mapWidth;
    const svgY = ((clientY - rect.top) / rect.height) * mapHeight;
    return {
      x: transform.fromX(svgX),
      y: transform.fromY(svgY),
    };
  }, [transform, mapWidth, mapHeight]);

  // ドラッグ開始
  const handleMouseDown = useCallback((index, e) => {
    if (!isEditing) return;
    e.preventDefault();
    setDraggingIndex(index);
  }, [isEditing]);

  // ドラッグ中
  const handleMouseMove = useCallback((e) => {
    if (draggingIndex === null || !isEditing) return;
    const newPoint = svgToPoint(e.clientX, e.clientY);
    if (!newPoint) return;

    const newPoints = points.map((p, i) =>
      i === draggingIndex
        ? { ...p, x: newPoint.x, y: newPoint.y }
        : p
    );
    onPointsChange(newPoints);
  }, [draggingIndex, isEditing, points, svgToPoint, onPointsChange]);

  // ドラッグ終了
  const handleMouseUp = useCallback(() => {
    setDraggingIndex(null);
  }, []);

  // マウスイベントのグローバルリスナー
  useEffect(() => {
    if (draggingIndex !== null) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [draggingIndex, handleMouseMove, handleMouseUp]);

  // 編集開始（現在のポイントをコピー）
  const startEditing = () => {
    if (!isEdited && generatedPoints.length) {
      onPointsChange([...generatedPoints]);
    }
    setIsEditing(true);
  };

  // 編集終了
  const stopEditing = () => {
    setIsEditing(false);
    setDraggingIndex(null);
  };

  // リセット（自動生成に戻す）
  const resetPoints = () => {
    onPointsChange(null);
    setIsEditing(false);
    setDraggingIndex(null);
  };

  // JSONで保存
  const saveAsJson = () => {
    const data = {
      version: 1,
      lapDuration: activeLapDuration,
      points: points.map(p => ({ x: p.x, y: p.y, time: p.time })),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'course_map.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  // JSONから読み込み
  const loadFromJson = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const data = JSON.parse(event.target.result);
        if (data.points && Array.isArray(data.points)) {
          onPointsChange(data.points);
          setIsEditing(false);
        }
      } catch (err) {
        console.error('JSONの解析に失敗しました:', err);
      }
    };
    reader.readAsText(file);
    // inputをリセット
    e.target.value = '';
  };

  if (!points.length || !transform) {
    return (
      <div className="course-map-empty">
        コースマップを表示するには、ST(%)データが必要です。
      </div>
    );
  }

  // SVGパスを構築
  const pathData =
    points.length && transform
      ? points
        .map(
          (p, i) =>
            `${i === 0 ? "M" : "L"} ${transform
              .toX(p.x)
              .toFixed(2)} ${transform.toY(p.y).toFixed(2)}`
        )
        .join(" ")
      : "";

  // 現在位置を補間で計算
  const wrapTime = activeLapDuration > 0 ? currentTime % activeLapDuration : 0;
  let currentPoint = points[0];

  for (let i = 0; i < points.length - 1; i++) {
    if (
      points[i].time <= wrapTime &&
      points[i + 1].time > wrapTime
    ) {
      const t =
        (wrapTime - points[i].time) /
        (points[i + 1].time - points[i].time);
      currentPoint = {
        x: points[i].x + (points[i + 1].x - points[i].x) * t,
        y: points[i].y + (points[i + 1].y - points[i].y) * t,
      };
      break;
    }
  }
  if (points.length && wrapTime >= points[points.length - 1].time) {
    currentPoint = points[points.length - 1];
  }

  // 編集モードで表示するハンドルの間引き
  const handleStep = Math.max(1, Math.floor(points.length / 24));

  return (
    <>
      {/* ツールバー */}
      <div className="course-map-toolbar">
        {!isEditing ? (
          <button onClick={startEditing} disabled={!points.length}>
            編集
          </button>
        ) : (
          <button className="primary" onClick={stopEditing}>
            編集終了
          </button>
        )}
        <button onClick={resetPoints} disabled={!isEdited} className={isEdited ? "danger" : ""}>
          リセット
        </button>
        <button onClick={saveAsJson} disabled={!points.length}>
          保存
        </button>
        <label className="file-input-label">
          読み込み
          <input type="file" accept=".json" onChange={loadFromJson} />
        </label>
        {isEdited && <span className="course-edit-badge">編集済み</span>}
      </div>

      <div className="course-map-container">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${mapWidth} ${mapHeight}`}
          className={`course-map-svg ${isEditing ? "editing" : ""}`}
        >
          {pathData ? (
            <>
              {/* コースの軌跡 */}
              <path
                d={pathData}
                fill="none"
                stroke="rgba(102, 194, 255, 0.4)"
                strokeWidth="8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d={pathData}
                fill="none"
                stroke="#66c2ff"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </>
          ) : null}

          {pathData ? (
            <>
              {/* スタート地点 */}
              <circle
                cx={transform.toX(points[0].x)}
                cy={transform.toY(points[0].y)}
                r="8"
                fill="#7ce38b"
                stroke="#fff"
                strokeWidth="2"
              />
              <text
                x={transform.toX(points[0].x)}
                y={transform.toY(points[0].y) - 14}
                fill="#7ce38b"
                fontSize="11"
                textAnchor="middle"
              >
                START
              </text>

              {/* 現在位置マーカー（編集モードでない場合のみ） */}
              {!isEditing && (
                <>
                  <circle
                    cx={transform.toX(currentPoint.x)}
                    cy={transform.toY(currentPoint.y)}
                    r="12"
                    fill="rgba(255, 122, 144, 0.3)"
                  />
                  <circle
                    cx={transform.toX(currentPoint.x)}
                    cy={transform.toY(currentPoint.y)}
                    r="6"
                    fill="#ff7a90"
                    stroke="#fff"
                    strokeWidth="2"
                  />
                </>
              )}

              {/* 編集ハンドル */}
              {isEditing && points.map((p, i) => {
                // 間引いて表示
                if (i % handleStep !== 0 && i !== points.length - 1) return null;
                return (
                  <circle
                    key={i}
                    cx={transform.toX(p.x)}
                    cy={transform.toY(p.y)}
                    r={draggingIndex === i ? 8 : 5}
                    fill={draggingIndex === i ? "#ffb454" : "rgba(255, 180, 84, 0.8)"}
                    stroke="#fff"
                    strokeWidth="1.5"
                    className={`course-edit-handle ${draggingIndex === i ? "dragging" : ""}`}
                    onMouseDown={(e) => handleMouseDown(i, e)}
                    style={{ cursor: 'grab' }}
                  />
                );
              })}
            </>
          ) : null}
        </svg>
      </div>
    </>
  );
}

// 動画プレーヤーコンポーネント（テレメトリーと同期再生）
function VideoPlayer({
  videoUrl,
  playTime,
  totalDuration,
  isPlaying,
  speed,
  syncMode,
  offsetMs,
}) {
  const videoRef = useRef(null);
  const lastSyncRef = useRef(0);

  // 動画の長さを取得
  const [videoDuration, setVideoDuration] = useState(0);

  const handleLoadedMetadata = useCallback(() => {
    if (videoRef.current) {
      setVideoDuration(videoRef.current.duration * 1000);
    }
  }, []);

  // playTime → video.currentTime の変換
  const getVideoTime = useCallback(
    (telemetryMs) => {
      if (!videoDuration) return 0;
      let videoMs;
      if (syncMode === "end") {
        // 動画の終了 = テレメトリーの終了
        videoMs = videoDuration - (totalDuration - telemetryMs) + offsetMs;
      } else {
        // 動画の開始 = テレメトリーの開始
        videoMs = telemetryMs + offsetMs;
      }
      return Math.max(0, Math.min(videoDuration, videoMs)) / 1000;
    },
    [videoDuration, totalDuration, syncMode, offsetMs]
  );

  // 再生・一時停止の制御
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !videoDuration) return;
    if (isPlaying) {
      video.playbackRate = speed;
      video.play().catch(() => { });
    } else {
      video.pause();
    }
  }, [isPlaying, speed, videoDuration]);

  // シーク同期（playTimeの変化に追従）
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !videoDuration) return;
    const targetTime = getVideoTime(playTime);
    const drift = Math.abs(video.currentTime - targetTime);
    // 0.3秒以上ずれたら補正（再生中の微小ずれは許容）
    if (drift > 0.3 || !isPlaying) {
      video.currentTime = targetTime;
    }
    lastSyncRef.current = playTime;
  }, [playTime, getVideoTime, videoDuration, isPlaying]);

  // speed変更時にplaybackRateを即座に更新
  useEffect(() => {
    const video = videoRef.current;
    if (video) video.playbackRate = speed;
  }, [speed]);

  if (!videoUrl) return null;

  return (
    <div className="video-container">
      <video
        ref={videoRef}
        src={videoUrl}
        onLoadedMetadata={handleLoadedMetadata}
        muted
        playsInline
      />
    </div>
  );
}

function App() {
  const [csvText, setCsvText] = useState(null);
  const [selectedMetrics, setSelectedMetrics] = useState(["ST(%)", "TH(%)"]);
  const [playTime, setPlayTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [selectedLap, setSelectedLap] = useState("");
  const [courseBaseSpeed, setCourseBaseSpeed] = useState(3);
  const [courseSteerGain, setCourseSteerGain] = useState(1);
  const [courseSteerSpeedLoss, setCourseSteerSpeedLoss] = useState(0.3);
  const [courseBrakeSpeedLoss, setCourseBrakeSpeedLoss] = useState(0.5);
  const [courseSteerGamma, setCourseSteerGamma] = useState(1.35);
  const [courseSmoothWindow, setCourseSmoothWindow] = useState(7);
  // 編集されたコースポイント（nullの場合は自動生成を使用）
  const [editedCoursePoints, setEditedCoursePoints] = useState(null);
  // 表示する秒数（0は全体表示）
  const [viewWindowSeconds, setViewWindowSeconds] = useState(0);
  // 動画関連
  const [videoUrl, setVideoUrl] = useState(null);
  const [videoSyncMode, setVideoSyncMode] = useState("start");
  const [videoOffsetMs, setVideoOffsetMs] = useState(0);
  const videoFileRef = useRef(null); // 元の動画Fileオブジェクトを保持（エクスポート用）
  const [csvFileName, setCsvFileName] = useState("");
  const [videoFileName, setVideoFileName] = useState("");
  const rafRef = useRef(null);
  const lastTimeRef = useRef(0);

  const { summary, columns, rows } = useMemo(() => {
    if (!csvText) return { summary: {}, columns: [], rows: [] };
    return parseCsv(csvText);
  }, [csvText]);

  const metrics = useMemo(() => {
    return columns.filter(
      (col) => !["LAP", "LAP TIME", "REC TIME"].includes(col)
    );
  }, [columns]);

  const totalDuration = rows.length ? rows[rows.length - 1].__recMs : 0;

  // 操作の周期性から予測したラップ情報
  const periodicityPrediction = useMemo(() => {
    return predictLapsFromPeriodicity(rows);
  }, [rows]);

  const lapData = useMemo(() => {
    const groups = [];
    let current = null;
    rows.forEach((row, index) => {
      const lapLabel = row.LAP && row.LAP.startsWith("L") ? row.LAP : "";
      if (lapLabel) {
        if (current) {
          current.end = index - 1;
          groups.push(current);
        }
        current = { label: lapLabel, start: index, end: index };
      }
      if (current) {
        current.end = index;
      }
    });
    if (current) groups.push(current);
    return groups;
  }, [rows]);

  useEffect(() => {
    if (!lapData.length) {
      setSelectedLap("");
      return;
    }
    if (!selectedLap || !lapData.some((lap) => lap.label === selectedLap)) {
      setSelectedLap(lapData[0].label);
    }
  }, [lapData, selectedLap]);

  useEffect(() => {
    if (!metrics.length) {
      setSelectedMetrics([]);
      return;
    }
    setSelectedMetrics((prev) => {
      const next = prev.filter((metric) => metrics.includes(metric));
      if (!next.length) return [metrics[0]];
      return next;
    });
  }, [metrics]);

  useEffect(() => {
    if (!isPlaying) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      lastTimeRef.current = 0;
      return;
    }

    const step = (now) => {
      if (!lastTimeRef.current) lastTimeRef.current = now;
      const delta = now - lastTimeRef.current;
      lastTimeRef.current = now;
      setPlayTime((prev) => {
        const next = prev + delta * speed;
        if (next >= totalDuration) {
          setIsPlaying(false);
          return totalDuration;
        }
        return next;
      });
      rafRef.current = requestAnimationFrame(step);
    };

    rafRef.current = requestAnimationFrame(step);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [isPlaying, speed, totalDuration]);

  useEffect(() => {
    setPlayTime(0);
    setIsPlaying(false);
    setSelectedLap("");
    setEditedCoursePoints(null);
  }, [csvText]);
  // （SVGマップ読み込みは廃止）

  const width = 800;
  const height = 320;
  const padding = 44;

  // 全体の時間範囲
  const fullTimeRange = rows.length
    ? {
      min: Math.min(...rows.map((row) => row.__recMs)),
      max: Math.max(...rows.map((row) => row.__recMs)),
    }
    : { min: 0, max: 0 };

  // 表示する時間範囲を計算（秒数指定の場合は現在位置を中心に）
  const viewTimeRange = useMemo(() => {
    if (viewWindowSeconds <= 0 || !rows.length) {
      return fullTimeRange;
    }
    const windowMs = viewWindowSeconds * 1000;
    const halfWindow = windowMs / 2;
    let viewMin = playTime - halfWindow;
    let viewMax = playTime + halfWindow;
    // 範囲を全体の範囲内に収める
    if (viewMin < fullTimeRange.min) {
      viewMin = fullTimeRange.min;
      viewMax = Math.min(fullTimeRange.max, viewMin + windowMs);
    }
    if (viewMax > fullTimeRange.max) {
      viewMax = fullTimeRange.max;
      viewMin = Math.max(fullTimeRange.min, viewMax - windowMs);
    }
    return { min: viewMin, max: viewMax };
  }, [viewWindowSeconds, playTime, fullTimeRange, rows.length]);

  // 表示範囲内のデータのみフィルター
  const visibleRows = useMemo(() => {
    if (viewWindowSeconds <= 0) return rows;
    return rows.filter(
      (row) => row.__recMs >= viewTimeRange.min && row.__recMs <= viewTimeRange.max
    );
  }, [rows, viewWindowSeconds, viewTimeRange]);

  const linePaths = selectedMetrics.map((metric) => ({
    metric,
    path: buildLinePath(visibleRows, metric, width, height, padding),
  }));

  const viewTimeSpan = viewTimeRange.max - viewTimeRange.min || 1;
  const playX =
    padding +
    ((playTime - viewTimeRange.min) / viewTimeSpan) * (width - padding * 2);
  const stMetric = "ST(%)";
  const thMetric = "TH(%)";
  const hasSt = columns.includes(stMetric);
  const hasTh = columns.includes(thMetric);
  const stValue = hasSt ? valueAtTime(rows, stMetric, playTime) : 0;
  const stMax = hasSt
    ? Math.max(
      ...rows.map((row) => Math.abs(getNumericValue(row[stMetric]))),
      1
    )
    : 1;
  const stOffset = Math.max(-1, Math.min(1, stValue / stMax));
  const thValue = hasTh ? valueAtTime(rows, thMetric, playTime) : 0;
  const thMax = hasTh
    ? Math.max(
      ...rows.map((row) => Math.abs(getNumericValue(row[thMetric]))),
      1
    )
    : 1;
  const thBrakeScale = Math.min(1, Math.max(0, -thValue / thMax));
  const thAccelScale = Math.min(1, Math.max(0, thValue / thMax));

  const handleFile = async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const text = await file.text();
    setCsvText(text);
    setCsvFileName(file.name);
  };

  const handleVideoFile = (event) => {
    const file = event.target.files[0];
    if (!file) return;
    // 既存のURLを解放
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    videoFileRef.current = file;
    setVideoFileName(file.name);
    setVideoUrl(URL.createObjectURL(file));
  };

  const removeVideo = () => {
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setVideoUrl(null);
    videoFileRef.current = null;
    setVideoFileName("");
  };

  // === .stg エクスポート ===
  const exportStg = async () => {
    if (!csvText) return;
    const zip = new JSZip();

    // manifest.json
    const manifest = {
      version: 1,
      format: "sanwa-telemetry-graph",
      createdAt: new Date().toISOString(),
      csv: {
        filename: csvFileName || "telemetry.csv",
      },
      video: videoFileRef.current
        ? {
          filename: videoFileName || videoFileRef.current.name,
          syncMode: videoSyncMode,
          offsetMs: videoOffsetMs,
        }
        : null,
      view: {
        selectedMetrics,
        viewWindowSeconds,
      },
      courseMap: {
        baseSpeed: courseBaseSpeed,
        steerGain: courseSteerGain,
        steerSpeedLoss: courseSteerSpeedLoss,
        brakeSpeedLoss: courseBrakeSpeedLoss,
        steerGamma: courseSteerGamma,
        smoothWindow: courseSmoothWindow,
        editedPoints: editedCoursePoints,
      },
    };
    zip.file("manifest.json", JSON.stringify(manifest, null, 2));

    // CSV
    zip.file(manifest.csv.filename, csvText);

    // 動画
    if (videoFileRef.current) {
      const videoData = await videoFileRef.current.arrayBuffer();
      zip.file(manifest.video.filename, videoData);
    }

    // ZIPをBlobとしてダウンロード
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const baseName = csvFileName
      ? csvFileName.replace(/\.[^.]+$/, "")
      : "session";
    a.href = url;
    a.download = `${baseName}.stg`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // === .stg インポート ===
  const importStg = async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      const zip = await JSZip.loadAsync(file);

      // manifest.json を読む
      const manifestFile = zip.file("manifest.json");
      if (!manifestFile) {
        alert("無効な .stg ファイルです（manifest.json がありません）");
        return;
      }
      const manifest = JSON.parse(await manifestFile.async("text"));

      // CSV を復元
      const csvFile = zip.file(manifest.csv?.filename || "telemetry.csv");
      if (csvFile) {
        const text = await csvFile.async("text");
        setCsvText(text);
        setCsvFileName(manifest.csv?.filename || "telemetry.csv");
      }

      // 動画を復元
      if (videoUrl) URL.revokeObjectURL(videoUrl);
      if (manifest.video?.filename) {
        const videoZipFile = zip.file(manifest.video.filename);
        if (videoZipFile) {
          const videoData = await videoZipFile.async("blob");
          const ext = manifest.video.filename.split(".").pop() || "mp4";
          const videoBlob = new Blob([videoData], {
            type: `video/${ext === "webm" ? "webm" : "mp4"}`,
          });
          // Fileオブジェクトとして保持（再エクスポート用）
          const restoredFile = new File([videoBlob], manifest.video.filename, {
            type: videoBlob.type,
          });
          videoFileRef.current = restoredFile;
          setVideoFileName(manifest.video.filename);
          setVideoUrl(URL.createObjectURL(videoBlob));
        }
        setVideoSyncMode(manifest.video.syncMode || "start");
        setVideoOffsetMs(manifest.video.offsetMs || 0);
      } else {
        setVideoUrl(null);
        videoFileRef.current = null;
        setVideoFileName("");
      }

      // 表示設定を復元
      if (manifest.view) {
        if (manifest.view.selectedMetrics) {
          setSelectedMetrics(manifest.view.selectedMetrics);
        }
        if (manifest.view.viewWindowSeconds != null) {
          setViewWindowSeconds(manifest.view.viewWindowSeconds);
        }
      }

      // コースマップ設定を復元
      if (manifest.courseMap) {
        const cm = manifest.courseMap;
        if (cm.baseSpeed != null) setCourseBaseSpeed(cm.baseSpeed);
        if (cm.steerGain != null) setCourseSteerGain(cm.steerGain);
        if (cm.steerSpeedLoss != null) setCourseSteerSpeedLoss(cm.steerSpeedLoss);
        if (cm.brakeSpeedLoss != null) setCourseBrakeSpeedLoss(cm.brakeSpeedLoss);
        if (cm.steerGamma != null) setCourseSteerGamma(cm.steerGamma);
        if (cm.smoothWindow != null) setCourseSmoothWindow(cm.smoothWindow);
        if (cm.editedPoints !== undefined) setEditedCoursePoints(cm.editedPoints);
      }
    } catch (err) {
      console.error(".stg ファイルの読み込みに失敗しました:", err);
      alert(".stg ファイルの読み込みに失敗しました: " + err.message);
    }
    // inputをリセット
    event.target.value = "";
  };

  // コンポーネントアンマウント時にURL解放
  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, []);

  const toggleMetric = (metric) => {
    setSelectedMetrics((prev) => {
      if (prev.includes(metric)) {
        const next = prev.filter((item) => item !== metric);
        return next.length ? next : [metric];
      }
      return [...prev, metric];
    });
  };

  const applyPredictedLapWindow = () => {
    const estimatedSeconds = periodicityPrediction.detectedPeriodMs / 1000;
    if (estimatedSeconds > 0) {
      setViewWindowSeconds(Number(estimatedSeconds.toFixed(2)));
    }
  };

  const seekBySeconds = (seconds) => {
    setPlayTime((prev) => {
      const next = prev + seconds * 1000;
      return Math.max(0, Math.min(totalDuration, next));
    });
  };

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.defaultPrevented) return;
      const target = event.target;
      const tagName = target?.tagName?.toLowerCase();
      if (tagName === "input" || tagName === "textarea" || tagName === "select") {
        return;
      }
      const step = event.shiftKey ? 10 : 5;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        seekBySeconds(-step);
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        seekBySeconds(step);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [seekBySeconds]);

  const palette = ["#66c2ff", "#ffb454", "#7ce38b", "#ff7a90", "#caa6ff"];
  const selectedLapRows = useMemo(() => {
    if (!selectedLap || !lapData.length) return rows.slice(0, 50);
    const lap = lapData.find((item) => item.label === selectedLap);
    if (!lap) return rows.slice(0, 50);
    return rows.slice(lap.start, lap.end + 1);
  }, [rows, lapData, selectedLap]);
  const autoCourseDirection = useMemo(() => detectCourseDirection(rows), [rows]);
  const courseOptions = useMemo(
    () => ({
      direction: autoCourseDirection,
      baseSpeed: courseBaseSpeed,
      lapSource: "periodicity",
      steerGain: courseSteerGain,
      steerSpeedLoss: courseSteerSpeedLoss,
      brakeSpeedLoss: courseBrakeSpeedLoss,
      steerGamma: courseSteerGamma,
      smoothWindow: courseSmoothWindow,
      baseDt: 50,
    }),
    [
      autoCourseDirection,
      courseBaseSpeed,
      courseSteerGain,
      courseSteerSpeedLoss,
      courseBrakeSpeedLoss,
      courseSteerGamma,
      courseSmoothWindow,
    ]
  );


  return (
    <div>
      <header>
        <h1>Sanwa Telemetry Graph</h1>
        <p>CSVを読み込んで時系列グラフとバー再生を確認できます。</p>
        <div className="session-controls">
          <button
            className="session-btn save"
            onClick={exportStg}
            disabled={!csvText}
            title="CSV・動画・同期設定をまとめて保存"
          >
            <span className="session-icon">💾</span> セッション保存
          </button>
          <label className="session-btn load" title=".stgファイルを読み込んで状態を復元">
            <span className="session-icon">📂</span> セッション読み込み
            <input
              type="file"
              accept=".stg"
              onChange={importStg}
              style={{ display: 'none' }}
            />
          </label>
        </div>
      </header>
      <main>
        <section className="panel">
          <h2>CSV読み込み</h2>
          <div className="upload">
            <input type="file" accept=".csv" onChange={handleFile} />
            {Object.keys(summary).length > 0 && (
              <div className="stats">
                {TIME_KEYS.map((key) => (
                  <div key={key} className="stat-card">
                    <span>{key}</span>
                    <strong>{summary[key]}</strong>
                  </div>
                ))}
              </div>
            )}
            <div className="stats">
              <div className="stat-card">
                <span>Records</span>
                <strong>{rows.length}</strong>
              </div>
              <div className="stat-card">
                <span>Total Time</span>
                <strong>{formatMs(totalDuration)}</strong>
              </div>
            </div>
          </div>
        </section>

        {/* 周期性から予測したラップ情報 */}
        {periodicityPrediction.predictedLapCount > 0 && (
          <section className="panel prediction-panel">
            <h2>周期性予測（操作パターンから推定）</h2>
            <div className="stats">
              <div className="stat-card prediction">
                <span>予測LAP数</span>
                <strong>{periodicityPrediction.predictedLapCount}</strong>
              </div>
              <div className="stat-card prediction">
                <span>予測BEST LAP</span>
                <strong>{periodicityPrediction.predictedBestLap ? formatMs(periodicityPrediction.predictedBestLap) : '-'}</strong>
              </div>
              <div className="stat-card prediction">
                <span>予測AVERAGE LAP</span>
                <strong>{periodicityPrediction.predictedAverageLap ? formatMs(periodicityPrediction.predictedAverageLap) : '-'}</strong>
              </div>
              <div className="stat-card prediction">
                <span>検出周期</span>
                <strong>{(periodicityPrediction.detectedPeriodMs / 1000).toFixed(2)}秒</strong>
              </div>
            </div>
            <p className="prediction-note">
              ※ステアリング操作の周期性から自動的に推定しています
            </p>
            <button
              className="secondary"
              onClick={applyPredictedLapWindow}
              disabled={periodicityPrediction.detectedPeriodMs <= 0}
            >
              グラフを推定1周に合わせる
            </button>
          </section>
        )}
        <section className="panel full">
          <h2>グラフ設定</h2>
          <div className="controls">
            <div className="metric-picker">
              {metrics.map((metric) => (
                <label key={metric} className="metric-option">
                  <input
                    type="checkbox"
                    checked={selectedMetrics.includes(metric)}
                    onChange={() => toggleMetric(metric)}
                  />
                  <span>{metric}</span>
                </label>
              ))}
            </div>
            <div className="zoom-controls">
              <label>
                表示範囲:
                <input
                  type="number"
                  min="0"
                  max="300"
                  step="1"
                  value={viewWindowSeconds}
                  onChange={(e) => setViewWindowSeconds(Math.max(0, Number(e.target.value)))}
                  style={{ width: '60px', marginLeft: '8px' }}
                />
                秒
              </label>
              <span className="zoom-hint">
                {viewWindowSeconds > 0 ? `${formatMs(viewTimeRange.min)} 〜 ${formatMs(viewTimeRange.max)}` : '全体表示'}
              </span>
              <button className="secondary" onClick={() => setViewWindowSeconds(0)}>
                全体表示
              </button>
              <button
                className="secondary"
                onClick={applyPredictedLapWindow}
                disabled={periodicityPrediction.detectedPeriodMs <= 0}
              >
                推定1周表示
              </button>
            </div>
          </div>
          <div className="chart-wrap">
            <svg viewBox={`0 0 ${width} ${height}`}>
              <g className="grid">
                {[0, 1, 2, 3, 4].map((row) => (
                  <line
                    key={row}
                    x1={padding}
                    x2={width - padding}
                    y1={padding + ((height - padding * 2) / 4) * row}
                    y2={padding + ((height - padding * 2) / 4) * row}
                  />
                ))}
              </g>
              <g className="axis">
                <text x={padding} y={height - 10}>
                  {formatMs(viewTimeRange.min)}
                </text>
                <text x={width - padding - 60} y={height - 10}>
                  {formatMs(viewTimeRange.max)}
                </text>
              </g>
              {linePaths.map((entry, index) => (
                <path
                  key={entry.metric}
                  d={entry.path}
                  stroke={palette[index % palette.length]}
                  strokeWidth="2"
                  fill="none"
                />
              ))}
              {rows.length ? (
                <line
                  x1={playX}
                  x2={playX}
                  y1={padding}
                  y2={height - padding}
                  stroke="rgba(255, 255, 255, 0.5)"
                  strokeDasharray="4 6"
                />
              ) : null}
            </svg>
          </div>
        </section>

        {/* 動画パネル */}
        <section className="panel full">
          <h2>動画再生</h2>
          <div className="video-panel">
            <div className="controls video-controls">
              <input type="file" accept="video/*" onChange={handleVideoFile} />
              {videoUrl && (
                <>
                  <label>
                    同期モード:
                    <select
                      value={videoSyncMode}
                      onChange={(e) => setVideoSyncMode(e.target.value)}
                    >
                      <option value="start">開始を合わせる</option>
                      <option value="end">終わりを合わせる</option>
                    </select>
                  </label>
                  <label>
                    オフセット:
                    <input
                      type="number"
                      step="100"
                      value={videoOffsetMs}
                      onChange={(e) => setVideoOffsetMs(Number(e.target.value))}
                      style={{ width: '80px' }}
                    />
                    ms
                  </label>
                  <div className="offset-fine-controls">
                    <button className="secondary" onClick={() => setVideoOffsetMs((v) => v - 1000)}>-1s</button>
                    <button className="secondary" onClick={() => setVideoOffsetMs((v) => v - 100)}>-0.1s</button>
                    <button className="secondary" onClick={() => setVideoOffsetMs(0)}>0</button>
                    <button className="secondary" onClick={() => setVideoOffsetMs((v) => v + 100)}>+0.1s</button>
                    <button className="secondary" onClick={() => setVideoOffsetMs((v) => v + 1000)}>+1s</button>
                  </div>
                  <button className="secondary danger" onClick={removeVideo}>
                    動画を削除
                  </button>
                </>
              )}
            </div>
            {videoUrl ? (
              <VideoPlayer
                videoUrl={videoUrl}
                playTime={playTime}
                totalDuration={totalDuration}
                isPlaying={isPlaying}
                speed={speed}
                syncMode={videoSyncMode}
                offsetMs={videoOffsetMs}
              />
            ) : (
              <div className="video-empty">
                動画ファイルを選択すると、テレメトリーと同期して再生します。
              </div>
            )}
          </div>
        </section>

        <section className="panel full">
          <h2>バー再生</h2>
          <div className="replay">
            <div className="controls">
              <button onClick={() => setIsPlaying((prev) => !prev)}>
                {isPlaying ? "Pause" : "Play"}
              </button>
              <button className="secondary" onClick={() => seekBySeconds(-10)}>
                -10s
              </button>
              <button className="secondary" onClick={() => seekBySeconds(-5)}>
                -5s
              </button>
              <button className="secondary" onClick={() => seekBySeconds(5)}>
                +5s
              </button>
              <button className="secondary" onClick={() => seekBySeconds(10)}>
                +10s
              </button>
              <button
                className="secondary"
                onClick={() => {
                  setPlayTime(0);
                  setIsPlaying(false);
                }}
              >
                Reset
              </button>
              <label>
                Speed:
                <select
                  value={speed}
                  onChange={(event) => setSpeed(Number(event.target.value))}
                >
                  {[0.5, 1, 2, 4].map((value) => (
                    <option key={value} value={value}>
                      {value}x
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Time:
                <input
                  type="range"
                  min="0"
                  max={totalDuration}
                  value={playTime}
                  onChange={(event) => setPlayTime(Number(event.target.value))}
                />
              </label>
            </div>
            {hasSt ? (
              <div className="replay-row">
                <div className="replay-label">ST(%)</div>
                <div className="steer-track">
                  <span className="steer-center" />
                  <span
                    className="steer-handle"
                    style={{ left: `calc(50% + ${stOffset * 50}%)` }}
                  />
                </div>
                <div className="replay-metrics">
                  <div>{stValue}</div>
                  <div>{formatMs(playTime)}</div>
                </div>
              </div>
            ) : null}
            {hasTh ? (
              <div className="replay-row">
                <div className="replay-label">TH(%)</div>
                <div className="throttle-bars">
                  <div className="throttle-half brake">
                    <span
                      className="throttle-fill brake"
                      style={{ transform: `scaleX(${thBrakeScale})` }}
                    />
                  </div>
                  <div className="throttle-half accel">
                    <span
                      className="throttle-fill accel"
                      style={{ transform: `scaleX(${thAccelScale})` }}
                    />
                  </div>
                </div>
                <div className="replay-metrics">
                  <div>{thValue}</div>
                  <div>{formatMs(playTime)}</div>
                </div>
              </div>
            ) : null}
            {!hasSt && !hasTh ? (
              <div className="replay-empty">
                ST(%) / TH(%) が見つからないため、バー表示できません。
              </div>
            ) : null}
          </div>
        </section>

        <section className="panel full">
          <h2>コースマップ</h2>
          <div className="course-map-panel">
            <div className="controls course-map-controls">
              <label>
                速度スケール:
                <input
                  type="number"
                  min="0.5"
                  max="10"
                  step="0.1"
                  value={courseBaseSpeed}
                  onChange={(e) => setCourseBaseSpeed(Number(e.target.value))}
                />
              </label>
              <label>
                切れ角（感度）:
                <input
                  type="number"
                  min="0.2"
                  max="3"
                  step="0.1"
                  value={courseSteerGain}
                  onChange={(e) => setCourseSteerGain(Number(e.target.value))}
                />
              </label>
              <label>
                操舵非線形(γ):
                <input
                  type="number"
                  min="0.5"
                  max="2.5"
                  step="0.05"
                  value={courseSteerGamma}
                  onChange={(e) => setCourseSteerGamma(Number(e.target.value))}
                />
              </label>
              <label>
                速度で曲がりにくくする:
                <input
                  type="number"
                  min="0"
                  max="1"
                  step="0.05"
                  value={courseSteerSpeedLoss}
                  onChange={(e) =>
                    setCourseSteerSpeedLoss(Number(e.target.value))
                  }
                />
              </label>
              <label>
                ブレーキで速度を落とす:
                <input
                  type="number"
                  min="0"
                  max="1"
                  step="0.05"
                  value={courseBrakeSpeedLoss}
                  onChange={(e) =>
                    setCourseBrakeSpeedLoss(Number(e.target.value))
                  }
                />
              </label>
              <label>
                平滑化窓(点数):
                <input
                  type="number"
                  min="1"
                  max="31"
                  step="2"
                  value={courseSmoothWindow}
                  onChange={(e) =>
                    setCourseSmoothWindow(Math.max(1, Math.floor(Number(e.target.value))))
                  }
                />
              </label>
            </div>
            <p className="course-map-description">
              推定周期（操作パターンから検出した1周）と操舵の偏りから方向を自動判定して描画します。速度による曲がりにくさとブレーキの効きも調整できます。
            </p>
            <div className="course-map-meta">
              周回方向: {autoCourseDirection === "cw" ? "右回り" : "左回り"}
            </div>
            {periodicityPrediction.detectedPeriodMs > 0 ? (
              <CourseMap
                rows={rows}
                lapTimeMs={periodicityPrediction.detectedPeriodMs}
                currentTime={playTime}
                options={courseOptions}
                editedPoints={editedCoursePoints}
                onPointsChange={setEditedCoursePoints}
              />
            ) : (
              <div className="course-map-empty">
                周期を検出できません。ST(%)が含まれるCSVを読み込んでください。
              </div>
            )}
          </div>
        </section>


        <section className="panel full">
          <h2>データプレビュー</h2>
          {lapData.length ? (
            <div className="controls">
              <label>
                LAP:
                <select
                  value={selectedLap}
                  onChange={(event) => setSelectedLap(event.target.value)}
                >
                  {lapData.map((lap) => (
                    <option key={lap.label} value={lap.label}>
                      {lap.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : null}
          <div className="table-preview">
            <table>
              <thead>
                <tr>
                  {columns.map((col) => (
                    <th key={col}>{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {selectedLapRows.map((row, index) => (
                  <tr key={`${row.LAP}-${index}`}>
                    {columns.map((col) => (
                      <td key={col}>{row[col]}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);
