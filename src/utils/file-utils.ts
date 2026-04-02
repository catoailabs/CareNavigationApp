export const fileToDataUrl = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
};

export const makePastedTextFilename = () => {
  const date = new Date().toISOString().replace(/[:.]/g, '-');
  return `pasted-text-${date}.txt`;
};