#!/usr/bin/env python3

import json
import sys
import os

def set_default_cotent(chapter : dict) -> None:
    if chapter["path"] is None:
        chapter["path"] = chapter["name"].lower().replace(' ', '_') + '.md'
        chapter["content"] = f"# {chapter['name']}\n"
    if "sub_items" in chapter:
        for item in chapter["sub_items"]:
            if "Chapter" in item:
                set_default_cotent(item["Chapter"])

META_FILES = {'index.md', 'log.md'}

def _read_title(filepath: str) -> str | None:
    """Read the first H1 heading (# ) from a file, outside code fences."""
    try:
        with open(filepath) as f:
            in_code_fence = False
            for line in f:
                stripped = line.strip()
                if stripped.startswith('```') or stripped.startswith('~~~'):
                    in_code_fence = not in_code_fence
                    continue
                if in_code_fence:
                    continue
                if stripped.startswith('# ') and not stripped.startswith('## '):
                    return stripped[2:].strip()
    except Exception:
        pass
    return None

def md_files_with_date(root: str) -> list[str]:
    md_files = {}
    for dirpath, dirnames, filenames in os.walk(root):
        # 附件/生成目录里的 .md 不是 wiki 页面（如 *.assets/README.md、
        # node_modules 依赖自带的 README.md），不应出现在 Latest updates：
        # 直接剪枝，不进入这些目录。
        dirnames[:] = [d for d in dirnames
                       if not d.endswith('.assets')
                       and d not in ('node_modules', 'dist', '.git')]
        for filename in filenames:
            if filename.endswith('.md'):
                if filename in META_FILES:
                    continue
                full_path = os.path.join(dirpath, filename)
                updated_date = get_git_updated_date(full_path)
                if updated_date not in md_files:
                    md_files[updated_date] = []
                md_files[updated_date].append(full_path)
    return md_files

def get_git_updated_date(file_path: str) -> str:
    import subprocess
    try:
        result = subprocess.run(
            ['git', 'log', '--diff-filter=M', '--follow', '--format=%ad', '--date=short', '--', file_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=True
        )
        date = result.stdout
        # if date is empty, return the date that the file was created
        if not date.strip():
            result = subprocess.run(
                ['git', 'log', '--diff-filter=A', '--follow', '--format=%ad', '--date=short', '--', file_path],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                check=True
            )
            date = result.stdout
        # if date is still empty, return the current date
        if not date.strip():
            from datetime import datetime
            date = datetime.now().strftime('%Y-%m-%d')
        return date
    except subprocess.CalledProcessError:
        return "Unknown Date"

if __name__ == '__main__':
    if len(sys.argv) > 1: # we check if we received any argument
        if sys.argv[1] == "supports": 
            # then we are good to return an exit status code of 0, since the other argument will just be the renderer's name
            sys.exit(0)

    # load both the context and the book representations from stdin
    context, book = json.load(sys.stdin)
    # add set path to the chapter's name for chapters that has a non-existing path
    for item in book['items']:
        if 'Chapter' in item:
            set_default_cotent(item['Chapter'])
    # and now, we can just modify the content of the first chapter
    files_group_by_date = md_files_with_date('src/docs/')
    lines = []
    # get latest 10 dates
    for date in sorted(files_group_by_date.keys(), reverse=True)[:10]:
        lines.append(f"## {date}\n")
        for file in sorted(files_group_by_date[date]):
            relative_path = os.path.relpath(file, 'src/')
            relative_path = relative_path.replace(' ', '%20')
            name = _read_title(file) or os.path.splitext(os.path.basename(file))[0]
            lines.append(f"> #### [{name}](./{relative_path})")
        lines.append("")  # add an empty line after each date group
    # with open('bin/debug_files.md', 'w', encoding='utf-8') as f:
    #     f.write("\n".join(all_files))
    book['items'].insert(0, {
        "Chapter": {
            "name": "Latest updates",
            "content": "\n".join(lines),
            "sub_items": [],
            "path": "latest_updates.md",
            "source_path": None,
            "parent_names": []
        }
    })
    with open('bin/debug.json', 'w', encoding='utf-8') as f:
        json.dump(book, f, indent=4, ensure_ascii=False)
    # book['items'][0]['Chapter']['content'] = '# Haha'
    # we are done with the book's modification, we can just print it to stdout, 
    print(json.dumps(book))
