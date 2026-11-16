"""Bundles the game + fake PeerJS into one self-contained HTML page for the two-player test.

    python3 test/build-harness.py > /tmp/harness.html

Each player runs that page in its own iframe (srcdoc) on any same-origin page. The ES
modules are concatenated into one inline module (imports/exports stripped), because a
srcdoc page can't load the relative js/ files.
"""
import pathlib
import re
import sys

root = pathlib.Path(__file__).resolve().parent.parent
read = lambda p: (root / p).read_text()

modules = []
for name in ['game.js', 'render.js', 'sound.js', 'net.js', 'app.js']:
    src = read(f'js/{name}')
    src = re.sub(r"^import .*? from '\./[a-z]+\.js';\n", '', src, flags=re.M)
    src = re.sub(r'^export (const|function|class|async function) ', r'\1 ', src, flags=re.M)
    modules.append(f'// ---- {name}\n{src}')
bundle = '\n'.join(modules)
# app.js uses `P.` for the game module; give it the same names as a namespace object.
game_names = re.findall(r'^export (?:const|function) ([A-Za-z_]+)', read('js/game.js'), flags=re.M)
bundle = bundle.replace('// ---- app.js', '// ---- app.js\nconst P = {%s};' % ', '.join(game_names), 1)

body = re.search(r'<body>(.*)</body>', read('index.html'), flags=re.S).group(1)
autopilot = '--manual' not in sys.argv
print(f"""<!doctype html><html><head><meta charset="utf-8"><title>CheapPong test</title>
<style>{read('style.css')}</style>
<script>window.CHEAPPONG_AUTOPILOT = {str(autopilot).lower()};</script>
<script>{read('test/fake-peer.js')}</script>
</head><body>{body}
<script type="module">{bundle}</script>
</body></html>""")
