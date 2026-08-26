import os
import webbrowser

# נתיב התיקייה המקומית שלך
DATASET_PATH = r"C:\Dev\exerciseDB\exercises-dataset-main"
HTML_FILE = "instagram_carousel.html"

# מילות מפתח לחיפוש אוטומטי של 3 התרגילים
KEYWORDS = {
    "EX1": ["single", "calf"],     # single leg floor calf raise
    "EX2": ["standing", "calf"],   # standing calf raise
    "EX3": ["seated", "calf"]     # dumbbell seated calf raise
}

found_images = {}

print("🔍 סורק את התיקייה המקומית לחילוץ אוטומטי של התמונות...")

# סריקה אוטומטית של התיקייה ותתי-התיקיות
for root, dirs, files in os.walk(DATASET_PATH):
    for file in files:
        file_lower = file.lower()
        if file_lower.endswith(('.gif', '.png', '.jpg', '.jpeg', '.webp')):
            full_path = os.path.join(root, file).replace('\\', '/')
            
            for key, words in KEYWORDS.items():
                if key not in found_images and all(word in file_lower for word in words):
                    found_images[key] = f"file:///{full_path}"
                    print(f"  ✅ נמצא תרגיל עבור {key}: {file}")

print("\n--- סיכום ממצאים ---")
for key in ["EX1", "EX2", "EX3"]:
    if key in found_images:
        print(f"{key}: {found_images[key]}")
    else:
        print(f"⚠️ {key}: לא נמצא קובץ תואם באופן אוטומטי.")

# עדכון קובץ ה-HTML
if os.path.exists(HTML_FILE):
    with open(HTML_FILE, "r", encoding="utf-8") as f:
        html_content = f.read()

    # החלפת נתיבי התמונות ב-HTML
    if "EX1" in found_images:
        html_content = html_content.replace(
            'src="file:///C:/Dev/exerciseDB/exercises-dataset-main/exercises/Single_Leg_Calf_Raise.gif"',
            f'src="{found_images["EX1"]}"'
        )
    if "EX2" in found_images:
        html_content = html_content.replace(
            'src="file:///C:/Dev/exerciseDB/exercises-dataset-main/exercises/Standing_Calf_Raise.gif"',
            f'src="{found_images["EX2"]}"'
        )
    if "EX3" in found_images:
        html_content = html_content.replace(
            'src="file:///C:/Dev/exerciseDB/exercises-dataset-main/exercises/Dumbbell_Seated_Calf_Raise.gif"',
            f'src="{found_images["EX3"]}"'
        )

    # שמירת הקובץ המעודכן
    with open(HTML_FILE, "w", encoding="utf-8") as f:
        f.write(html_content)
    
    print("\n🎉 קובץ ה-HTML עודכן בהצלחה!")
    
    # פתיחה אוטומטית בדפדפן
    abs_html_path = os.path.abspath(HTML_FILE)
    webbrowser.open(f"file:///{abs_html_path}")
else:
    print(f"❌ הקובץ {HTML_FILE} לא נמצא באותה תיקייה.")