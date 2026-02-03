import React, { useState, useMemo, useEffect } from 'react';
import {
  Text,
  View,
  Pressable,
  Alert,
  TextInput,
  Platform,
} from 'react-native';
import DraggableFlatList from 'react-native-draggable-flatlist';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { PDFDocument } from 'pdf-lib';
import { Buffer } from 'buffer';

type PdfItem = {
  id: string;
  name: string;
  uri: string;
  pages: number;
};

/** ===== 設定値 ===== */
const MAX_TOTAL_PAGES = 150;

/** ===== Base64変換（Android対応）===== */
const base64ToUint8Array = (base64: string) =>
  Uint8Array.from(Buffer.from(base64, 'base64'));

const uint8ArrayToBase64 = (bytes: Uint8Array) =>
  Buffer.from(bytes).toString('base64');

/** ===== Android content URI を cache にコピー ===== */
const normalizePdfUri = async (uri: string) => {
  if (Platform.OS !== 'android') return uri;

  // content:// のみ対象
  if (!uri.startsWith('content://')) return uri;

  const fs: any = FileSystem;
  const cacheDir = fs.cacheDirectory;

  if (!cacheDir) {
    throw new Error('cacheDirectory が取得できません');
  }

  const fileName = `tmp_${Date.now()}.pdf`;
  const dest = cacheDir + fileName;

  await FileSystem.copyAsync({
    from: uri,
    to: dest,
  });

  return dest;
};

export default function App() {
  const [data, setData] = useState<PdfItem[]>([]);
  const [fileName, setFileName] = useState('');
  const [merging, setMerging] = useState(false);

  /** 先頭PDF名からデフォルト名生成 */
  const getDefaultMergedName = () => {
    if (data.length === 0) return 'merged.pdf';
    const base = data[0].name.replace(/\.pdf$/i, '');
    return `${base}_merged.pdf`;
  };

  /** 並び替え・追加時に自動更新 */
  useEffect(() => {
    setFileName(getDefaultMergedName());
  }, [data]);

  /** PDF追加（ページ数即取得） */
  const pickPdf = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: 'application/pdf',
      multiple: true,
    });

    if (result.canceled) return;

    try {
      const items: PdfItem[] = [];

      for (let i = 0; i < result.assets.length; i++) {
        const file = result.assets[i];

        // ★ ここが今回の肝
        const safeUri = await normalizePdfUri(file.uri);

        const base64 = await FileSystem.readAsStringAsync(safeUri, {
          encoding: 'base64' as any,
        });

        const bytes = base64ToUint8Array(base64);
        const pdf = await PDFDocument.load(bytes);

        items.push({
          id: `${Date.now()}-${i}`,
          name: file.name ?? 'unknown.pdf',
          uri: safeUri, // ★ 正規化後URIを保持
          pages: pdf.getPageCount(),
        });
      }

      setData(prev => [...prev, ...items]);
    } catch (e: any) {
      console.error('PDF読み込みエラー:', e);
      Alert.alert(
        'PDFの読み込みに失敗しました',
        e?.message ?? String(e)
      );
    }
  };

  /** PDF削除 */
  const removePdf = (id: string) => {
    Alert.alert('削除確認', 'このPDFを削除しますか？', [
      { text: 'キャンセル', style: 'cancel' },
      {
        text: '削除',
        style: 'destructive',
        onPress: () =>
          setData(prev => prev.filter(p => p.id !== id)),
      },
    ]);
  };

  /** 合計ページ数 */
  const totalPages = useMemo(
    () => data.reduce((sum, p) => sum + p.pages, 0),
    [data]
  );

  /** PDF結合処理（保存してURI返却） */
  const buildMergedPdf = async (finalName: string) => {
    try {
      const mergedPdf = await PDFDocument.create();

      for (const item of data) {
        const base64 = await FileSystem.readAsStringAsync(item.uri, {
          encoding: 'base64' as any,
        });

        const bytes = base64ToUint8Array(base64);
        const pdf = await PDFDocument.load(bytes);

        const pages = await mergedPdf.copyPages(
          pdf,
          pdf.getPageIndices()
        );
        pages.forEach(p => mergedPdf.addPage(p));
      }

      const mergedBytes = await mergedPdf.save();
      const mergedBase64 = uint8ArrayToBase64(mergedBytes);

      const fs: any = FileSystem;
      const dir =
        fs.cacheDirectory ?? fs.documentDirectory;

      if (!dir) throw new Error('保存先ディレクトリが取得できません');

      const uri = dir + finalName;

      await FileSystem.writeAsStringAsync(uri, mergedBase64, {
        encoding: 'base64' as any,
      });

      return uri;
    } catch (e) {
      console.error('PDF結合エラー:', e);
      throw e;
    }
  };

  /** 結合ボタン押下 */
  const onPressMerge = () => {
    if (data.length < 2) {
      Alert.alert('PDFを2つ以上選択してください');
      return;
    }

    if (totalPages > MAX_TOTAL_PAGES) {
      Alert.alert(
        'ページ数上限を超えています',
        `合計 ${totalPages} ページです。\n\n本アプリでは ${MAX_TOTAL_PAGES} ページまで結合できます。`
      );
      return;
    }

    const finalName =
      fileName.trim() !== ''
        ? fileName
        : getDefaultMergedName();

    Alert.alert(
      'PDF結合',
      `ファイル名：\n${finalName}\n\n${data.length}件\n合計 ${totalPages} ページ`,
      [
        { text: 'キャンセル', style: 'cancel' },
        {
          text: 'ファイルを保存する',
          onPress: async () => {
            try {
              setMerging(true);
              await buildMergedPdf(finalName);
              Alert.alert('完了', 'ファイルを保存しました');
            } catch (e: any) {
              Alert.alert(
                '保存に失敗しました',
                e?.message ?? String(e)
              );
            } finally {
              setMerging(false);
            }
          },
        },
        {
          text: 'ファイルを共有する',
          onPress: async () => {
            try {
              setMerging(true);
              const uri = await buildMergedPdf(finalName);

              if (Platform.OS !== 'web') {
                await Sharing.shareAsync(uri);
              } else {
                Alert.alert('Webでは共有できません');
              }
            } catch (e: any) {
              Alert.alert(
                '共有に失敗しました',
                e?.message ?? String(e)
              );
            } finally {
              setMerging(false);
            }
          },
        },
      ]
    );
  };

  /** 行描画 */
  const renderItem = ({ item, drag, isActive }: any) => {
    const index = data.findIndex(p => p.id === item.id);

    return (
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingVertical: 14,
          paddingHorizontal: 12,
          backgroundColor: isActive ? '#e0e0e0' : '#fff',
          borderBottomWidth: 1,
          borderColor: '#ddd',
        }}
      >
        <Text
          style={{
            width: 28,
            textAlign: 'right',
            marginRight: 12,
            fontWeight: 'bold',
            color: '#1976d2',
          }}
        >
          {index + 1}
        </Text>

        <Pressable
          onLongPress={drag}
          disabled={isActive}
          style={{ flex: 1 }}
        >
          <Text>{item.name}</Text>
          <Text style={{ fontSize: 12, color: '#666' }}>
            {item.pages} ページ
          </Text>
        </Pressable>

        <Pressable onPress={() => removePdf(item.id)}>
          <Text
            style={{
              fontSize: 18,
              color: '#d32f2f',
              fontWeight: 'bold',
              paddingHorizontal: 8,
            }}
          >
            ×
          </Text>
        </Pressable>
      </View>
    );
  };

  return (
    <View style={{ flex: 1, paddingTop: 60 }}>
      <Text style={{ fontSize: 22, fontWeight: 'bold', margin: 16 }}>
        PDF 結合
      </Text>

      <Pressable onPress={pickPdf} style={{ margin: 16 }}>
        <Text>＋ PDFを追加</Text>
      </Pressable>

      <DraggableFlatList
        data={data}
        keyExtractor={item => item.id}
        renderItem={renderItem}
        onDragEnd={({ data }) => setData(data)}
      />

      <View style={{ padding: 16, borderTopWidth: 1, borderColor: '#ddd' }}>
        <Text
          style={{
            fontWeight: 'bold',
            color: totalPages > MAX_TOTAL_PAGES ? '#d32f2f' : '#000',
          }}
        >
          合計：{totalPages} ページ
          {totalPages > MAX_TOTAL_PAGES && '（上限超過）'}
        </Text>

        <Text style={{ marginTop: 8 }}>保存ファイル名</Text>
        <TextInput
          value={fileName}
          onChangeText={setFileName}
          autoCapitalize="none"
          style={{
            borderWidth: 1,
            borderColor: '#ccc',
            padding: 8,
            marginTop: 4,
          }}
        />

        <Pressable
          onPress={onPressMerge}
          disabled={merging}
          style={{
            marginTop: 16,
            backgroundColor: '#1976d2',
            padding: 12,
            alignItems: 'center',
            opacity: merging ? 0.6 : 1,
          }}
        >
          <Text style={{ color: '#fff' }}>
            {merging ? '処理中…' : 'PDFを結合'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
