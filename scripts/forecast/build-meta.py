#!/usr/bin/env python3
"""
Write the small metadata file that the NestJS importer stores with a forecast run.

    python3 scripts/forecast/build-meta.py \
      --forecast forecast_out/forecasts_2026-10.json \
      --out forecast_out/forecast_meta_2026-10.json

The model version is a short hash of config.json plus the three LightGBM model files. It changes whenever the
data team replaces the model artifact, so two imports of the same month with different models remain distinct.
"""
import argparse
import datetime
import hashlib
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MODELS = os.path.join(ROOT, 'Forecast_Model', 'models')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--forecast', default=os.path.join(ROOT, 'forecast_out', 'forecasts_2026-10.json'))
    parser.add_argument('--out', default=os.path.join(ROOT, 'forecast_out', 'forecast_meta_2026-10.json'))
    parser.add_argument('--models', default=MODELS)
    args = parser.parse_args()

    config_path = os.path.join(args.models, 'config.json')
    with open(config_path, encoding='utf-8') as fh:
        config = json.load(fh)

    digest = hashlib.sha256()
    with open(config_path, 'rb') as fh:
        digest.update(fh.read())
    for name in ('lightgbm_region.txt', 'lightgbm_province.txt', 'lightgbm_center.txt'):
        with open(os.path.join(args.models, name), 'rb') as fh:
            digest.update(fh.read())
    model_version = 'lightgbm-' + digest.hexdigest()[:12]

    with open(args.forecast, encoding='utf-8') as fh:
        rows = json.load(fh)
    months = sorted({r['forecast_month'] for r in rows})
    if len(months) != 1:
        raise SystemExit(f'Expected one forecast month, found {months}')
    target_months = sorted({r['target_month'] for r in rows})

    meta = {
        'forecast_month': months[0],
        'target_months': target_months,
        'generated_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'model_version': model_version,
        'sample_rate': config.get('sample_rate', 0.2),
        'trained_on': config.get('trained_on'),
        'test_accuracy': config.get('test_accuracy'),
        'versions': config.get('versions'),
        'row_count': len(rows),
        'source': 'Forecast_Model/forecast.py',
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, 'w', encoding='utf-8') as fh:
        json.dump(meta, fh, indent=1)
        fh.write('\n')
    print('wrote', args.out)
    print('  forecast month:', meta['forecast_month'])
    print('  target months:', ', '.join(meta['target_months']))
    print('  model version:', meta['model_version'])
    print('  rows:', meta['row_count'])


if __name__ == '__main__':
    main()
