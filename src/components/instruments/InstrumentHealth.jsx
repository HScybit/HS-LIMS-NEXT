'use client';

const items = [
  { key: 'calibrated', label: 'Calibrated', color: '#00b242', labelColor: '#00792b' },
  { key: 'notCalibrated', label: 'Not calibrated', color: '#ffcfcc', labelColor: '#ff2725' },
  { key: 'inBreakdown', label: 'In breakdown', color: '#ec1d1d', labelColor: '#c62828' },
  { key: 'noCalibrationData', label: 'No Service', color: '#e6e8eb', labelColor: '#6c737f' },
];
export default function InstrumentHealth({ health }) {
  const { healthy, total, inBreakdown, maintenanceOverdue } = health;
  const percentage = total ? Math.round(healthy / total * 100) : 0;
  const segments = items.map((item, index) => {
    const size = total ? health[item.key] / total * 100 : 0;
    const start = total ? items.slice(0, index).reduce((sum, prior) => sum + health[prior.key], 0) / total * 100 : 0;
    const angle = (start + size / 2) * Math.PI / 50 - Math.PI / 2;
    return { ...item, count: health[item.key], size, start, x: 120 + Math.cos(angle) * 105, y: 120 + Math.sin(angle) * 105 };
  }).filter(item => item.count > 0);
  return <div className="smplfy-instruments-dashboard-cards row g-3 align-items-start"><div className="col-12">
    <section className="smplfy-card smplfy-instruments-health-card card"><div className="card-header bg-white d-flex align-items-center"><h2 className="h5 mb-0 fw-semibold text-dark">Instrument Health</h2></div>
      <div className="card-body smplfy-instruments-health-overview"><div className="smplfy-instruments-health-summary d-flex flex-column align-items-center justify-content-center text-center">
        <div className="smplfy-instruments-health-meter position-relative" role="img" aria-label={`${healthy} of ${total} instruments are healthy (${percentage}%).`}>
          <svg className="smplfy-instruments-health-chart" viewBox="0 0 360 188" aria-hidden="true"><path d="M 40 156 A 140 140 0 0 1 320 156" fill="none" stroke="#c6f5d0" strokeWidth="18" />
            <path d="M 40 156 A 140 140 0 0 1 320 156" fill="none" stroke="#00b83f" strokeWidth="18" pathLength="100" strokeDasharray={`${percentage} 100`} /></svg>
          <div className="smplfy-instruments-health-copy position-absolute start-50 translate-middle text-center" aria-hidden="true"><div className="smplfy-instruments-health-value">{percentage}%</div><div className="smplfy-instruments-health-label">CALIBRATED</div></div>
        </div>
        <span className="smplfy-instruments-health-pill badge rounded-pill border px-3 py-2 fw-medium">{healthy}/{total} Instruments are healthy.</span>
        {inBreakdown > 0 ? <span className="text-danger small mt-2">{inBreakdown} in breakdown</span> : null}
        {maintenanceOverdue > 0 ? <span className="text-danger small">{maintenanceOverdue} maintenance overdue</span> : null}
      </div>
      <div className="smplfy-calibration-breakdown"><div className="smplfy-calibration-breakdown-content"><div className="smplfy-calibration-breakdown-graphic">
        <svg className="smplfy-calibration-breakdown-chart" viewBox="0 0 240 240" role="img" aria-label={items.map(item => `${item.label}: ${health[item.key]}`).join('. ') + `. Total instruments: ${total}.`}>
          {segments.map(item => <g key={item.key}><circle cx="120" cy="120" r="78" fill="none" stroke={item.color} strokeWidth="24" pathLength="100"
            strokeDasharray={`${Math.max(0.01, item.size - 0.28)} 100`} strokeDashoffset={-item.start} transform="rotate(-90 120 120)" />
            <text x={item.x} y={item.y} fill={item.labelColor} fontFamily="Inter, sans-serif" fontSize="17" fontWeight="600" textAnchor="middle" dominantBaseline="middle">{item.count}</text></g>)}
        </svg><div className="smplfy-calibration-breakdown-center" aria-hidden="true"><strong>{total ? Math.round(health.calibrated / total * 100) : 0}%</strong><span>Calibrated</span></div>
      </div><ul className="smplfy-calibration-breakdown-legend list-unstyled mb-0" aria-hidden="true">{items.map(item => <li key={item.key}>
        <span className="smplfy-calibration-breakdown-swatch" style={{ backgroundColor: item.color }} /><span className="smplfy-calibration-breakdown-legend-label">{item.label}</span>
      </li>)}</ul></div></div></div>
    </section></div></div>;
}
