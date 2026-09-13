-- Fix the 13 core (approved) exercises that slipped through the original
-- T-28 region backfill (0029) because they aren't uniquely tied to one
-- protocol region -- each appears in protocols spanning >=2 regions. Primary
-- region is the clinically dominant one; the other referenced regions are
-- recorded as secondary via app.exercise_secondary_region (added in 0036,
-- unused until now). Dual-called (migration + seed.sql) because these are
-- seeded system exercises re-inserted by protocols_import.sql/seed.sql on
-- every `db reset`, same pattern as 0029/0037's dual-call.
create or replace function app._catalog_fix_core_region_gaps_2026_09_13()
returns void
language plpgsql
as $$
declare
  v_shoulder uuid := (select id from app.body_region where slug = 'shoulder');
  v_spine uuid := (select id from app.body_region where slug = 'spine');
  v_hip_thigh uuid := (select id from app.body_region where slug = 'hip_thigh');
  v_knee uuid := (select id from app.body_region where slug = 'knee');
  v_lower_leg uuid := (select id from app.body_region where slug = 'lower_leg');
  v_ankle_foot uuid := (select id from app.body_region where slug = 'ankle_foot');
  v_other uuid := (select id from app.body_region where slug = 'other');
  v_map jsonb := jsonb_build_object(
    'Ankle Alphabet', jsonb_build_array('ankle_foot', jsonb_build_array('lower_leg')),
    'Calf Stretch', jsonb_build_array('lower_leg', jsonb_build_array('ankle_foot')),
    'Change of Direction Drills', jsonb_build_array('knee', jsonb_build_array('hip_thigh')),
    'Dead Bug', jsonb_build_array('spine', jsonb_build_array('hip_thigh')),
    'Eccentric Heel Drop (Alfredson)', jsonb_build_array('ankle_foot', jsonb_build_array('lower_leg')),
    'Hip Flexor Stretch', jsonb_build_array('hip_thigh', jsonb_build_array('knee')),
    'Isometric Calf Hold', jsonb_build_array('lower_leg', jsonb_build_array('ankle_foot')),
    'Quad Stretch', jsonb_build_array('hip_thigh', jsonb_build_array('knee')),
    'Running Gait Retraining', jsonb_build_array('other', jsonb_build_array('hip_thigh', 'knee')),
    'Scapular Retraction', jsonb_build_array('shoulder', jsonb_build_array('spine')),
    'Side-Lying Hip Abduction', jsonb_build_array('hip_thigh', jsonb_build_array('knee')),
    'Standing Calf Raise', jsonb_build_array('lower_leg', jsonb_build_array('ankle_foot')),
    'Step-Ups', jsonb_build_array('knee', jsonb_build_array('hip_thigh'))
  );
  v_slug_to_id jsonb := jsonb_build_object(
    'shoulder', v_shoulder, 'spine', v_spine, 'hip_thigh', v_hip_thigh,
    'knee', v_knee, 'lower_leg', v_lower_leg, 'ankle_foot', v_ankle_foot, 'other', v_other
  );
  v_name text;
  v_entry jsonb;
  v_primary_slug text;
  v_secondary_slug text;
  v_exercise_id uuid;
begin
  for v_name, v_entry in select * from jsonb_each(v_map)
  loop
    v_primary_slug := v_entry->>0;

    select id into v_exercise_id
    from app.exercise
    where name_en = v_name and status = 'approved' and item_kind = 'exercise';

    if v_exercise_id is null then
      continue;
    end if;

    update app.exercise
    set body_region_id = (v_slug_to_id->>v_primary_slug)::uuid
    where id = v_exercise_id;

    for v_secondary_slug in select jsonb_array_elements_text(v_entry->1)
    loop
      insert into app.exercise_secondary_region (exercise_id, body_region_id)
      values (v_exercise_id, (v_slug_to_id->>v_secondary_slug)::uuid)
      on conflict do nothing;
    end loop;
  end loop;
end;
$$;

select app._catalog_fix_core_region_gaps_2026_09_13();
