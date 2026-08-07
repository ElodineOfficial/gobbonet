@echo off
"C:\Users\Elidyne\AppData\Local\GobboNet\llama-cpp\llama-server.exe" --model "C:\Users\Elidyne\AppData\Local\GobboNet\models\nomic-embed-text-v1.5.Q8_0.gguf" --port 11436 --host 127.0.0.1 --embeddings --pooling mean --ctx-size 2048 --batch-size 2048 --ubatch-size 2048 --n-gpu-layers 0 > "C:\Users\Elidyne\AppData\Local\GobboNet\embed-server.log" 2>&1
