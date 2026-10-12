"""Create an offline UI font subset from Noto Sans CJK SC (OFL-1.1)."""
import sys
from pathlib import Path
from fontTools import subset
from fontTools.ttLib import TTFont
root=Path(__file__).resolve().parents[1]
text=''.join(p.read_text() for p in (root/'web').glob('*') if p.suffix in ('.html','.js','.css'))
text+=''.join(chr(i) for i in range(32,127))
options=subset.Options();options.name_IDs=['*'];options.name_legacy=True;options.name_languages=['*']
font=TTFont(sys.argv[1]);sub=subset.Subsetter(options=options);sub.populate(text=text);sub.subset(font)
for record in font['name'].names:
    if record.nameID in (1,4,6):
        name='DiSHUI' if record.nameID==6 else 'DiSH UI'
        record.string=name.encode(record.getEncoding())
font.save(root/'web/assets/fonts/dish-ui.otf')
print('UI glyph subset written')
