import base58, json, os, sys

secret = base58.b58decode(os.environ['SOLANA_DEPLOY_KEY'])
with open(sys.argv[1], 'w') as f:
    json.dump(list(secret), f)
