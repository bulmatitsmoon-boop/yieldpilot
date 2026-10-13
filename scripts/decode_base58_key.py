import base58, json, os, sys

env_name = sys.argv[1]
out_path = sys.argv[2]
secret = base58.b58decode(os.environ[env_name])
with open(out_path, "w") as f:
    json.dump(list(secret), f)
