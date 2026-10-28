// Add this object inside the modules array of MagicMirror/config/config.js.
// Do not put account credentials in the MagicMirror browser configuration.
{
  module: "MMM-Libre2",
  position: "top_right",
  header: "Glucose",
  config: {
    units: "mmol/L",
    timeFormat: 24,
    "overColor": "orange",
    "underColor": "red",
    "withinRangeColor": "springgreen",
    staleAfterMinutes: 10,
    showGraph: true,
    graphHours: 6,
    width: 320,
    height: 360,
    minMmol: 3.9,
    maxMmol: 10,
    showSecondaryDisplayText: true
  }
}
