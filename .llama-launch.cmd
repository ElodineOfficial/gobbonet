@echo off
"C:\Users\Elidyne\AppData\Local\GobboNet\llama-cpp\llama-server.exe" --model "C:\Users\Elidyne\AppData\Local\GobboNet\models\google_gemma-4-26B-A4B-it-Q4_K_S.gguf" --port 11434 --host 127.0.0.1 --ctx-size 16384 --n-gpu-layers 99 --cache-type-k q8_0 --cache-type-v q8_0 --parallel 1 --jinja  --reasoning-format auto > "C:\Users\Elidyne\AppData\Local\GobboNet\llama-server.log" 2>&1
