export function getLocationFromFile(
  file: string,
  content: string,
  searchText: string
) {
  const pos = content.indexOf(searchText);
  if (pos < 0) {
    throw new Error(`text "${searchText}" not found in content:\n${content}`);
  }
  const partialContent = content.substring(0, pos);
  const startPos = getEndPositionFromText(partialContent);

  return {
    file,
    start: startPos,
    end: { ...startPos, offset: startPos.offset + searchText.length },
  };
}

export function getEndPositionFromText(content: string){
  const lines = content.split("\n");
  const offset = lines[lines.length - 1].length + 1;

  return {
    line: lines.length,
    offset: offset,
  }
}
