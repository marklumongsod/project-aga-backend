# New assessment center model: artifact

Estimates a new (or planned) assessment center's candidates in each of its first 12 months after accreditation, and its
chance of getting any candidates in that year.

## Files

| File | What it is |
|---|---|
| `models/new_center_count.json` | Count model (XGBoost): expected candidates per month |
| `models/new_center_start.txt` | Chance model (LightGBM): chance of at least one candidate in 12 months |
| `models/config.json` | Inputs (in order), categorical inputs, cap rule, sample rate, versions, test accuracy |
| `models/example_input.csv`, `example_output.csv`, `example_output_chance.csv` | Real input rows of 3 centers and the exact predictions expected |
| `new_center_inputs.py` | Builds the inputs for a center from the raw data (same rules as the panel notebook) |
| `predict_new_center.py` | Loads the models, builds the inputs, predicts |
| `example_centers.json`, `example_predictions.json` | A planned center and its prediction |

## Input (per center)

| Field | Required | Example |
|---|---|---|
| `province_id` | yes | 45 |
| `qual_ids` | yes | [101, 205] (QualId values from the Qualification sheet) |
| `accreditation_month` | yes | "2026-09" (at most one month after the last complete month of data) |
| `city_id` | no | 1203 |
| `school_ids` | no | [8841] if the center is also a school (SchId) |
| `center_type`, `center_class` | no | 2, 1 |
| `latitude`, `longitude` | no | 14.6, 121.0 |

The script looks up everything else (learners nearby, competitors, province market) from the raw data, as of the month
before accreditation.

## Run

    pip install -r requirements.txt
    python predict_new_center.py --data-dir /path/to/Data --last-month 2026-08 --centers example_centers.json --out predictions.json

## Backend HTTP service

`service.py` loads the inputs once and serves `/health`, `/meta`, `/predict` and `/reload` for the NestJS backend.
See `docs/new-centers/README.md` and `Dockerfile`.

`--data-dir` needs the same 10 CSV files and `Qualification.xlsx` as the project `Data` folder. Loading takes about
25 seconds; each center then takes a fraction of a second.

## Output (per center)

| Field | Meaning |
|---|---|
| `chance_any_candidates` | Chance of at least one candidate in the first 12 months (0 to 1) |
| `first_year_expected_real` | Expected candidates in the first 12 months (real number = sample ÷ 0.2) |
| `monthly` | Expected candidates for each month 1 to 12 (sample and real) |

## How good it is (363 new centers accredited January-September 2025)

| Measure | Value |
|---|---|
| First-year error (WAPE) | 120% (best earlier model 134%) |
| Bias | +28% (forecasts too high; 2025 centers had a weak first year) |
| Province totals error | 68% (best earlier model 86%) |
| Chance of starting, ranking (0 = no help, 1 = perfect) | 0.56 |

Use it as a guide: to compare sites or qualification choices and to add up expected volume, not as an exact number for one
center. Once a center has had candidates, the main forecast model takes over.

## Retraining

Run the New Center Panel notebook on new data, then the New Center Machine Learning Models notebook (section 7 writes new
model files here).
