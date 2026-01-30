import mmap
import os
import time
import struct
import json
import random

SHM_NAME = "/dev/shm/pulsescope_shm"
# 与 C++ Layout 保持一致的结构大小
# ShmLayout: magic(4), version(4), image(8+4+4+4 + 2MB + 4), telemetry(8+4 + 64KB + 4), ...
IMAGE_SECTION_SIZE = 8 + 4 + 4 + 4 + (1024 * 1024 * 2) + 4
TELEMETRY_SECTION_SIZE = 8 + 4 + (64 * 1024) + 4
TOTAL_SIZE = 8 + IMAGE_SECTION_SIZE + TELEMETRY_SECTION_SIZE + 1024*64 # 粗略估计

def main():
    mock_img_path = os.path.join(os.path.dirname(__file__), "mock_frame.jpg")
    mock_img_data = None
    if os.path.exists(mock_img_path):
        with open(mock_img_path, "rb") as f:
            mock_img_data = f.read()

    if not os.path.exists(SHM_NAME):
        with open(SHM_NAME, "wb") as f:
            f.write(b'\x00' * (5 * 1024 * 1024)) # 预留 5MB
    
    with open(SHM_NAME, "r+b") as f:
        mm = mmap.mmap(f.fileno(), 0)
        
        # Header: magic='PSCP'(0x50534350), version=1
        mm[0:4] = struct.pack("<I", 0x50534350)
        mm[4:8] = struct.pack("<I", 1)
        
        print("Simulator started. Writing dummy data to SHM...")
        
        seq = 0
        while True:
            seq += 1
            # 使用真实调试图片（如果存在）
            if mock_img_data:
                img_data = mock_img_data
                w, h = 2000, 1129
            else:
                # 备选方案：生成一个交替颜色的简单 JPEG (100x100)
                if (seq // 30) % 2 == 0:
                    # 红色 100x100
                    img_data = b'\xff\xd8\xff\xdb\x00C\x00\x08\x06\x06\x07\x06\x05\x08\x07\x07\x07\t\t\x08\n\x0c\x14\r\x0c\x0b\x0b\x0c\x19\x12\x13\x0f\x14\x1d\x1a\x1f\x1e\x1d\x1a\x1c\x1c $.\' ",#\x1c\x1c(7),01444\x1f\'9=82<.342\xff\xc0\x00\x11\x08\x00d\x00d\x03\x01"\x00\x02\x11\x01\x03\x11\x01\xff\xc4\x00\x1f\x00\x00\x01\x05\x01\x01\x01\x01\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x01\x02\x03\x04\x05\x06\x07\x08\t\n\x0b\xff\xc4\x00\xb5\x10\x00\x02\x01\x03\x03\x02\x04\x03\x05\x05\x04\x04\x00\x00\x01}\x01\x02\x03\x00\x04\x11\x05\x12!1A\x06\x13Qa\x07"q\x142\x81\x91\xa1\x08#B\xb1\xc1\x15R\xd1\xf0$3br\x82\x16\x17\x18\x19\x1a%&\'()*456789:CDEFGHIJSTUVWXYZcdefghijstuvwxyz\x83\x84\x85\x86\x87\x88\x89\x8a\x92\x93\x94\x95\x96\x97\x98\x99\x9a\xa2\xa3\xa4\xa5\xa6\xa7\xa8\xa9\xaa\xb2\xb3\xb4\xb5\xb6\xb7\xb8\xb9\xba\xc2\xc3\xc4\xc5\xc6\xc7\xc8\xc9\xca\xd2\xd3\xd4\xd5\xd6\xd7\xd8\xd9\xda\xe1\xe2\xe3\xe4\xe5\xe6\xe7\xe8\xe9\xea\xf1\xf2\xf3\xf4\xf5\xf6\xf7\xf8\xf9\xfa\xff\xda\x00\x0c\x03\x01\x00\x02\x11\x03\x11\x00?\x00\xf5Z\xef\xd9'
                else:
                    # 蓝色 100x100
                    img_data = b'\xff\xd8\xff\xdb\x00C\x00\x08\x06\x06\x07\x06\x05\x08\x07\x07\x07\t\t\x08\n\x0c\x14\r\x0c\x0b\x0b\x0c\x19\x12\x13\x0f\x14\x1d\x1a\x1f\x1e\x1d\x1a\x1c\x1c $.\' ",#\x1c\x1c(7),01444\x1f\'9=82<.342\xff\xc0\x00\x11\x08\x00d\x00d\x03\x01"\x00\x02\x11\x01\x03\x11\x01\xff\xc4\x00\x1f\x00\x00\x01\x05\x01\x01\x01\x01\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x01\x02\x03\x04\x05\x06\x07\x08\t\n\x0b\xff\xc4\x00\xb5\x10\x00\x02\x01\x03\x03\x02\x04\x03\x05\x05\x04\x04\x00\x00\x01}\x01\x02\x03\x00\x04\x11\x05\x12!1A\x06\x13Qa\x07"q\x142\x81\x91\xa1\x08#B\xb1\xc1\x15R\xd1\xf0$3br\x82\x16\x17\x18\x19\x1a%&\'()*456789:CDEFGHIJSTUVWXYZcdefghijstuvwxyz\x83\x84\x85\x86\x87\x88\x89\x8a\x92\x93\x94\x95\x96\x97\x98\x99\x9a\xa2\xa3\xa4\xa5\xa6\xa7\xa8\xa9\xaa\xb2\xb3\xb4\xb5\xb6\xb7\xb8\xb9\xba\xc2\xc3\xc4\xc5\xc6\xc7\xc8\xc9\xca\xd2\xd3\xd4\xd5\xd6\xd7\xd8\xd9\xda\xe1\xe2\xe3\xe4\xe5\xe6\xe7\xe8\xe9\xea\xf1\xf2\xf3\xf4\xf5\xf6\xf7\xf8\xf9\xfa\xff\xda\x00\x0c\x03\x01\x00\x02\x11\x03\x11\x00?\x00\xf2\xbf\xef\xd9'
                w, h = 100, 100

            image_base = 8
            mm[image_base:image_base+8] = struct.pack("<Q", seq) # seq
            mm[image_base+8:image_base+12] = struct.pack("<I", len(img_data)) # size
            mm[image_base+12:image_base+16] = struct.pack("<I", w) # width
            mm[image_base+16:image_base+20] = struct.pack("<I", h) # height
            mm[image_base+20:image_base+20+len(img_data)] = img_data # data
            
            # 2. Simulate Telemetry
            tel_base = 8 + IMAGE_SECTION_SIZE
            telemetry = {
                "timestamp": time.time(),
                "ekf": {
                    "pos": [random.uniform(-5, 5) for _ in range(3)],
                    "yaw": random.uniform(0, 360)
                },
                "target": "hero" if random.random() > 0.5 else "infantry"
            }
            tel_json = json.dumps(telemetry).encode('utf-8')
            mm[tel_base:tel_base+8] = struct.pack("<Q", seq)
            mm[tel_base+8:tel_base+12] = struct.pack("<I", len(tel_json))
            mm[tel_base+12:tel_base+12+len(tel_json)] = tel_json
            
            time.sleep(0.033) # ~30 FPS

if __name__ == "__main__":
    main()
