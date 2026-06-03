# Gobbonet — Your Own Private AI Chat [May change to Grotto, we'll see what happens]

Gobbonet lets you run an AI chatbot **on your own computer**, with no accounts, no monthly fees, and nothing sent to the internet. The AI lives on your machine. When you talk to it, your words never leave your home.

This guide assumes you've never set up anything like this before. Take it one step at a time and you'll be chatting in about 20–30 minutes (most of that is just waiting for files to download).

---
## Working models

- **Llama** — working
- **Gemma** — working
- **DeepSeek** — working
- **Mistral** — hit and miss [cydonia works, midnight violet works]
- **Granite** — working
- **Command R** — working
- **GLM** — working
---

## What you're actually setting up

- There's a small **launcher** (a file called `launch.bat`) that starts everything for you.
- There's the **AI engine** — the program that does the actual thinking. It's about 300 MB and downloads once.
- There's the **AI model** — this is the "brain." It's a big file (usually 4–16 GB). You pick one from a menu and it downloads once.
- There's the **chat screen** itself, which opens in your web browser like a normal website — except it's running entirely on your own computer.

You download the engine and a model **one time**. After that, everything runs offline, forever.

---

## What you need before you start

- **A Windows 10 or Windows 11 PC.** (This doesn't work on Mac or Linux as written.)
- **A graphics card (GPU) helps a lot.** The AI runs *much* faster on a graphics card. It will still run without a good one, just slowly. The setup checks your hardware and recommends a model that fits.
- **Free hard-drive space.** At least 10–20 GB free, ideally more. The AI models are large.
- **An internet connection for the first setup only.** After the one-time downloads, you can unplug from the internet and it still works.

You do **not** need to be technical, create any account, enter a credit card, or install anything complicated.

---

## Step 1 — Put the files in one folder

Make a new folder somewhere easy to find, like `Documents\Gobbonet`. Put **all** of these files into it, together:

- `launch.bat`
- `setup-lan.bat`
- `fileserver.ps1`
- `hardware-probe.ps1`
- `chat.html`
- `style.css`
- `default-characters.json`
- `models-list.json`

They all need to live in the **same** folder. Don't put them in separate subfolders.

---

## Step 2 — Run the launcher

Double-click **`launch.bat`**.

A black window with green text will open. This is normal — it's the launcher talking to you. **Read what it says**, because it asks you a few simple questions the first time.

### It will ask you to set a password

The very first time, it asks you to **choose a password**. Type one (at least 6 characters) and press Enter, then type it again to confirm.

This password protects your chat. Anyone else on your home Wi-Fi could otherwise open it, so the password keeps it private. You'll only type it again when you connect from your phone.

> Your password is stored in a scrambled form that can't be reversed, and it never leaves your computer. If you forget it, you can set a new one (see Troubleshooting).

### It will offer to download the AI engine

Next it says the engine isn't installed yet and asks **"Download llama.cpp now?"** Type **Y** and press Enter. This is the ~300 MB one-time download. Wait for it to finish.

### It will help you pick a model (the AI "brain")

If you don't have a model yet, it checks your computer's hardware and shows a menu like this:

```
Detected: 16 GB VRAM, 32 GB RAM, 423 GB free disk

[1] Gemma 3 4B IT          ~4.7 GB
[2] Llama 3.2 3B Instruct  ~3.3 GB
...
[5] Gemma 4 26B-A4B MoE    ~16 GB   [ RECOMMENDED FOR YOUR PC ]
...
[9] Skip — I'll add my own
```

One option is marked **`[ RECOMMENDED FOR YOUR PC ]`** — that's the best fit for your hardware. Just press **Enter** to accept it, or type a number to pick a different one. Then wait while it downloads (a big model can take 10–30 minutes — this is the longest part, and it only happens once).

If a model needs more graphics memory than you have, it warns you and asks if you want it anyway. When in doubt, pick the recommended one.

### That's it

Once the model loads, your **web browser opens automatically** to the chat screen. You can start typing.

Every time you want to use it in the future, you just double-click `launch.bat` again. After the first setup, it starts in well under a minute and **never needs the internet**.

---

## Step 3 (optional) — Use it from your phone

You can chat from your phone or tablet **as long as it's on the same Wi-Fi** as your PC. This is optional — skip it if you only want to use it on the PC.

1. **Right-click `setup-lan.bat`** and choose **"Run as administrator."** Say yes to any Windows prompt. This opens the door for your phone to connect. You only ever do this **once**.
2. Look at the launcher window. When it starts, it prints the exact web address to use on your phone, something like:

   ```
   On your phone: http://your-pc-name.local:8080
   ```

3. On your phone's browser, type that address. Enter the password you chose. Done.

> **Bookmark the `.local` address, not the number address.** The `.local` one keeps working even if your PC's network address changes, so your saved chats won't disappear.

---

## Using the chat

Gobbonet is more than a plain chatbox. Here are the parts you'll actually use, in plain terms:

- **Just type and chat.** Type in the box at the bottom, press Enter. That's the basics.
- **Characters.** It comes with a few built-in personalities (a terse coder, a wordy lore-keeper, a riddle-speaking oracle). You can switch between them or make your own — give it a name, a description, and a style, and the AI will play that role. You can also **bring in character cards you already have, and send yours back out** (the common `.png` cards used by other AI chat apps), so your existing collection works here too. Most cards carry over cleanly, though a few may need small tweaks after importing.
- **Threads.** Each conversation is saved separately in the sidebar, like chat history. You can rename them, pin favorites, and sort them into folders.
- **Web search (optional).** There's a search button that lets the AI look things up online. This is the *one* feature that needs the internet and a free key — see below. Everything else is fully offline.
- **Switching models.** If you've downloaded more than one model, you can switch between them from a dropdown at the top — no need to restart.
- **Saving files.** If you ask the AI to write something like code or a document, it can give you a **Save** button to download it.
- **Settings.** A gear/settings area lets you tweak things, change the look, and manage your data.

### Turning on web search (optional)

The search button needs a free key from Ollama:

1. Go to **ollama.com**, make a free account, and get an **API key**.
2. In Gobbonet, open **Settings** and paste the key into the API-key box.
3. Now the search button works. (Searches go through Ollama; everything else stays on your machine.)

If you never set this up, the chat still works perfectly — you just won't have the live-search button.

---

## Keeping it private and safe

This tool was built to be private, but a few honest notes:

- **The AI itself is 100% offline.** Your conversations are not sent anywhere. There are no accounts and no tracking.
- **The password keeps other people out.** Anyone on your Wi-Fi could otherwise reach the chat, so don't disable it.
- **The connection is not encrypted.** This is fine on a home network you trust. **Don't run this on public or shared Wi-Fi** (like a coffee shop), and don't reuse an important password here.
- **Your chats are saved in your browser.** If you clear your browser data, or switch browsers, your history may not carry over (though the app tries to back it up and offer to restore it).

---

## Shutting it down

To stop everything: find the launcher window (the black window with green text — it shrinks to your taskbar after a few seconds) and **close it**, or click it and press **Ctrl + C**.

That window quietly watches the AI in the background and restarts it if it ever hiccups, so it's normal for it to stay open while you're using the chat.

---

## Troubleshooting

**The chat says it can't connect to the AI / it's very slow.**
The model may be running on your processor instead of your graphics card, which is slow. The launcher warns you if it couldn't confirm your GPU is being used. Make sure your graphics drivers are up to date (search your card maker's site: AMD, Intel, or NVIDIA). If it's still slow, pick a smaller model next time.

**My phone can't connect.**
Make sure your phone is on the **same Wi-Fi** as the PC. Then run `setup-lan.bat` as administrator (right-click → Run as administrator) one time. If the `.local` address doesn't work, try the number address the launcher prints instead.

**My saved chats disappeared.**
This usually happens when you opened the chat at a different web address than before (for example, the PC's network number changed). The app keeps a backup and will usually offer to restore it. To avoid this entirely, always use the `.local` address and bookmark it.

**I forgot my password.**
You can set a new one. Either delete the hidden file named `.gobbonet-secret` from your Gobbonet folder, or open the launcher folder, hold Shift and right-click in empty space, choose the terminal/command option, and run:
```
launch.bat reset-password
```
It will ask you to set a fresh password. Restart your computer after this or it will not take properly.

**The download failed.**
Run `launch.bat` again — it will pick up where it left off. If the engine or a model repeatedly fails, your internet may be blocking it; try again on a different connection. The launcher also prints manual download links if you'd rather grab the files yourself.

**A model is too big and crashes or errors during chat.**
It's running out of graphics memory. Use a smaller model from the download menu, or ask whoever set this up to lower the context size in `launch.bat`.

### Specific errors you might see

Sometimes an error code shows up. Here's what the common ones mean and the quickest fix for each.

**The chat won't load, or you see a `500` error.**
Your model is too big for your graphics card's memory. The "context limit" (how much the AI can read at once) plus the model size is asking for more memory than you have. Use a smaller model, or have someone lower the context size in `launch.bat`.

**The model won't load, or you see a `502` error.**
The most likely cause: another AI program called **Ollama** started up on its own and grabbed the port Gobbonet needs. Close Ollama (check your system tray near the clock, right-click its icon, and quit it), then run `launch.bat` again.

**The web address won't load on my phone.**
The phone address can change when the PC or its network restarts. First, double-check you're typing the **exact** address the launcher window currently shows — it may have changed since last time. Bookmarking the `.local` address (instead of the number address) avoids this.

**Switching models gave me a `404` error.**
The model file is probably in the wrong place. Make sure every `.gguf` file is inside the **`models`** folder, directly — not in a subfolder and not loose in the main folder.

**Switching models gave me a `502` error.**
Open **Task Manager** (press Ctrl + Shift + Esc), find anything labeled **"Windows PowerShell,"** and end those tasks. Then run `launch.bat` again. This clears out a stuck background process.

---
## Known bugs
We like to be upfront about what's broken. These two are confirmed, and we're working to fix them ASAP. We'll update this section as we squash them.

**Logit bias is broken**: (this is what powers "banned words"). 
The banned-words feature — the one that's supposed to discourage specific words from showing up — relies on logit bias under the hood, and logit bias isn't working right now. Banning a word won't reliably keep it out of replies. For the moment, treat the feature as non-functional rather than just hit-or-miss. (You'll see this flagged in the feature list too.)

**Some models using the "Tekken" tokenizer misbehave.** 
A handful of models are built on the Tekken tokenizer, and those don't run correctly yet — you may see scrambled or garbled output, odd spacing, or wrong special tokens/formatting. If a model is acting strange in a way that looks like jumbled text, this is the likely cause. Switch to a different model in the meantime until we ship a fix. We have identified the problem and applied a patch, but it may not be thorough enough to squash the problem. More testing is required at this time. 

---
## Quick reference

| I want to… | Do this |
|---|---|
| Start the chat | Double-click `launch.bat` |
| Use it on my phone | Run `setup-lan.bat` as administrator once, then use the address shown |
| Change my password | Run `launch.bat reset-password` |
| Add another AI model | Put a `.gguf` file in the `models` folder, or use the launcher's menu |
| Turn on web search | Paste a free Ollama key into Settings |
| Shut it down | Close the green launcher window |

---

## Full feature list

Everything Gobbonet can do, grouped so it's easy to scan.

**Chatting**
- Streaming responses — replies appear word-by-word in real time as the AI thinks.
- Stop button — cut off a reply mid-sentence whenever you want.
- Reroll — not happy with an answer? Regenerate it with one click.
- Copy, edit, delete, or reroll any individual reply.
- Copy button on code blocks — grab code in one tap.
- Token counter — see how much of the AI's "memory" you're using.
- Chain-of-thought (reasoning) view — on models that support it, you can watch the AI's step-by-step thinking.
- Auto-stop on stuck reasoning — if the AI's thinking gets caught in an endless loop, it's cut off automatically instead of running forever.

**Conversations & organizing**
- Landing page — a home dashboard you start from each time.
- Conversation threads — every chat is saved separately, like a history list.
- Rename any thread; copy, edit, or delete threads.
- Search your conversations — find an old chat by what was said in it.
- Folders, tags, and pins — sort chats into folders, label them with tags, and pin your favorites to the top.
- Branching conversations — fork a chat at any point to explore a different direction without losing the original.
- Memory + summarization — older parts of a long chat are automatically summarized so the AI keeps remembering what matters.
- Drag-and-drop file attachments — drag a file straight into the chat to attach it.

**Characters & personas**
- Default characters — comes with ready-made personalities to chat with right away.
- Character cards — build your own detailed characters (name, description, personality, style, settings).
- Import and export character cards (V2/V3) — bring in the standard `.png` character cards used by other popular AI chat apps, and export your own back out in the same format. Cards are cross-compatible both directions, so you don't have to recreate a library you already own. Honest note: most cards carry over cleanly, but some may need a little tweaking after import.
- Lorebook import — embedded lorebooks come across with their underlying information preserved. Honest note: some extras like tags are dropped during import, but the actual lore content itself stays intact.
- Copy, edit, or delete characters.
- Alternate greetings — give a character several different opening lines.
- User personas — create a profile for *yourself* so the AI knows who it's talking to.
- Avatar, background, and text-color customization — make each character and the chat look the way you want.

**Writing & macros**
- `{{char}}` and `{{user}}` placeholders — automatically fill in the character's and your name as you chat.
- `{{current_DAT}}` — lets the AI know the current date and time.
- Built-in macros like `{{continue}}` and `{{fast forward}}` to nudge a story or task along.
- `{{auto_continue_x}}` — keeps a story or task running on its own so it makes progress while you step away.
- Custom macros — create your own shortcuts for text or actions you use a lot.

**The AI's behavior (controls)**
- System prompt editing — change the underlying instructions that shape how the AI behaves.
- System prompt carousel — save several system prompts and swap between them quickly.
- Response controls — fine-tune things like temperature and top-k to make replies more focused or more creative.
- Banned words — discourage specific words from appearing (best-effort, not guaranteed, appears to be bugged at this time).
- Model selector — choose which AI model you're talking to.
- Model hot-swap — switch to a different downloaded model without restarting anything.

**Web search (optional)**
- Search the web — let the AI look things up online (needs a free Ollama key).
- Privacy protection — identifying metadata and telemetry are stripped from your searches.

**Saving & getting things out**
- Save AI output as a `.txt` or `.json` file. (Other file types are intentionally left out for now to keep things simple and safe.)
- Export, import, or purge all your data — back up everything to a file, restore it later, or wipe it completely.

**Customization (advanced)**
- Internal "mod" controls — add your own custom JavaScript extensions and override the stylesheet to change how the app looks and works.

**Scheduling**
- Scheduled tasks — set prompts to send themselves at specific times.
- Copy, edit, or delete scheduled tasks.

**Devices**
- PC-to-phone connection — use the same chat from your phone or tablet over your home Wi-Fi.

---

*Gobbonet is brought to you by the GoblinCorps. No corpo money, no venture capital, no masters.*
