import struct,sys
src,dst=sys.argv[1:3]
b=bytearray(open(src,'rb').read())
pe=struct.unpack_from('<I',b,0x3c)[0]; opt=pe+24
magic=struct.unpack_from('<H',b,opt)[0]
dd=opt+(112 if magic==0x20b else 96)
off,size=struct.unpack_from('<II',b,dd+32)
assert off+size==len(b), (off,size,len(b))
struct.pack_into('<II',b,dd+32,0,0)
struct.pack_into('<I',b,opt+64,0)  # checksum
open(dst,'wb').write(b[:off])
print('stripped',len(b),'->',off)
