import base58, json, os, sys

secret = base58.b58decode(os.environ['MAINNET_PROGRAM_KEYPAIR'])
with open(sys.argv[1], 'w') as f:
    json.dump(list(secret), f)
