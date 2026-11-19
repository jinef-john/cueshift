import sys

import numpy as np
import webrtcvad

source, target = sys.argv[1], sys.argv[2]
pcm = np.fromfile(source, dtype=np.int16)
vad = webrtcvad.Vad(3)
count = len(pcm) // 320
raw = pcm[: count * 320].tobytes()
speech = np.array([vad.is_speech(raw[i * 640 : (i + 1) * 640], 16000) for i in range(count)], dtype=np.uint8)

frames = int(np.ceil(count * 0.02 / 0.05))
index = ((np.arange(count) * 0.02 + 0.01) / 0.05).astype(int)
said = np.zeros(frames)
total = np.zeros(frames)
np.add.at(said, index, speech)
np.add.at(total, index, 1)
(256 * said / np.maximum(total, 1)).astype(np.int16).tofile(target)
