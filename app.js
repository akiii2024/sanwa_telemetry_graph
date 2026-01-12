const { useEffect, useMemo, useRef, useState } = React;

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

function App() {
  const [csvText, setCsvText] = useState(null);
  const [selectedMetric, setSelectedMetric] = useState("RPM");
  const [playTime, setPlayTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
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

  useEffect(() => {
    if (metrics.length && !metrics.includes(selectedMetric)) {
      setSelectedMetric(metrics[0]);
    }
  }, [metrics, selectedMetric]);

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
  }, [csvText]);

  const width = 800;
  const height = 320;
  const padding = 44;
  const linePath = buildLinePath(rows, selectedMetric, width, height, padding);
  const replayMetrics = ["ST(%)", "TH(%)"].filter((metric) =>
    columns.includes(metric)
  );
  const replayData = replayMetrics.map((metric) => {
    const value = valueAtTime(rows, metric, playTime);
    const max = Math.max(
      ...rows.map((row) => Math.abs(getNumericValue(row[metric]))),
      1
    );
    return { metric, value, max };
  });

  const handleFile = async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const text = await file.text();
    setCsvText(text);
  };

  return (
    <div>
      <header>
        <h1>Sanwa Telemetry Graph</h1>
        <p>CSVを読み込んで時系列グラフとバー再生を確認できます。</p>
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

        <section className="panel">
          <h2>グラフ設定</h2>
          <div className="controls">
            <label>
              指標:
              <select
                value={selectedMetric}
                onChange={(event) => setSelectedMetric(event.target.value)}
              >
                {metrics.map((metric) => (
                  <option key={metric} value={metric}>
                    {metric}
                  </option>
                ))}
              </select>
            </label>
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
                  0
                </text>
                <text x={width - padding - 20} y={height - 10}>
                  {formatMs(totalDuration)}
                </text>
              </g>
              <path
                d={linePath}
                stroke="var(--accent)"
                strokeWidth="2"
                fill="none"
              />
            </svg>
          </div>
        </section>

        <section className="panel full">
          <h2>バー再生</h2>
          <div className="replay">
            <div className="controls">
              <button onClick={() => setIsPlaying((prev) => !prev)}>
                {isPlaying ? "Pause" : "Play"}
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
            {replayData.length ? (
              replayData.map(({ metric, value, max }) => {
                const scale = Math.min(1, Math.abs(value) / max);
                const isNegative = value < 0;
                return (
                  <div key={metric} className="replay-row">
                    <div className="replay-label">{metric}</div>
                    <div className="replay-bar dual">
                      <span
                        className="baseline"
                        aria-hidden="true"
                      />
                      <span
                        className={`bar-fill ${isNegative ? "neg" : "pos"}`}
                        style={{
                          transform: `${isNegative ? "translateX(-100%)" : "translateX(0)"} scaleX(${scale})`,
                          transformOrigin: isNegative ? "right center" : "left center",
                        }}
                      />
                    </div>
                    <div className="replay-metrics">
                      <div>{value}</div>
                      <div>{formatMs(playTime)}</div>
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="replay-empty">
                ST(%) / TH(%) が見つからないため、バー表示できません。
              </div>
            )}
          </div>
        </section>

        <section className="panel full">
          <h2>データプレビュー</h2>
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
                {rows.slice(0, 50).map((row, index) => (
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
