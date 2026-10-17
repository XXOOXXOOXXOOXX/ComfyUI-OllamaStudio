"""Stop sustained periodic tails without changing ordinary, varied prose."""
def repeated_tail_cutoff(text):
    if len(text) < 128:
        return None
    tail = text[-8192:].lower()
    for width in range(4, min(512, len(tail) // 8) + 1):
        block = tail[-width:]
        if not block.strip() or width * 8 < 128:
            continue
        if any(tail[-width * (index + 1):-width * index] != block for index in range(1, 8)):
            continue
        copies = 8
        while (copies + 1) * width <= len(tail) and tail[-width * (copies + 1):-width * copies] == block:
            copies += 1
        start = len(tail) - width * copies
        for period in range(4, width // 2 + 1):
            if width % period == 0 and block == block[:period] * (width // period):
                width = period
                break
        while start > 0 and tail[start - 1] == tail[start - 1 + width]:
            start -= 1
        absolute = max(0, len(text) - len(tail) + start)
        while absolute > 0 and text[absolute - 1].lower() == text[absolute - 1 + width].lower():
            absolute -= 1
        return absolute + width
    return None
