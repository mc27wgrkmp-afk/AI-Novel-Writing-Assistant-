"""Start the optional Gemini-API engine using the existing private configuration."""
import argparse
from pathlib import Path

from gemini_gateway.http import serve

if __name__ == '__main__':
    root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', type=Path, default=root / '.local/gemini-web2api/config.json')
    args = parser.parse_args()
    serve(root, args.config)
