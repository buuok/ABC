import os,sys,zipfile,stat
src,out=sys.argv[1:3]
with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
    for root,dirs,files in os.walk(src):
        dirs.sort()
        rel=os.path.relpath(root,os.path.dirname(src))
        zi=zipfile.ZipInfo(rel+'/'); zi.create_system=3; zi.external_attr=(0o40755<<16)|0x10; z.writestr(zi,b'')
        for f in sorted(files):
            p=os.path.join(root,f); mode=os.stat(p).st_mode
            zi=zipfile.ZipInfo.from_file(p,os.path.join(rel,f)); zi.create_system=3
            zi.external_attr=((0o100755 if mode&0o111 else 0o100644)<<16)
            zi.compress_type=zipfile.ZIP_DEFLATED
            with open(p,'rb') as fh: z.writestr(zi,fh.read(),compresslevel=6)
print(out,os.path.getsize(out))
